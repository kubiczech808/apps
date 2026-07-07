from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Iterable


MODEL_CONFIG = {
    'en': {'models': [('Helsinki-NLP/opus-mt-cs-en', '')]},
    'de': {'models': [('Helsinki-NLP/opus-mt-cs-de', '')]},
    'pl': {'models': [
        ('Helsinki-NLP/opus-mt-cs-en', ''),
        ('pumad/pumadic-en-pl', ''),
    ]},
}

LANGUAGE_NAMES = {'en': 'English', 'de': 'German', 'pl': 'Polish'}
TOKEN_RE = re.compile(r'(?s)(<!--.*?-->|<[^>]+>)')
SHORTCODE_RE = re.compile(r'^\s*\[[A-Za-z_][^\]]*\]\s*$')
SPACE_RE = re.compile(r'^(\s*)(.*?)(\s*)$', re.S)
SENTENCE_RE = re.compile(r'(?<=[.!?])\s+(?=[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ])')
PROTECTED_TERMS = [
    'Tajemství JAMU', 'Jamu Balance Pure', 'Jamu Balance', 'Dharma Pure',
    'Tanamu Tanami', 'Kalila Kalila', 'Sacred Flowers', 'Bali spirit',
    'Nadis Herbal', 'Bali Flowers', 'Bali Moon Face', 'Minyak Balur',
    'Kutus Kutus', 'Praha Vršovice', 'Ústí nad Orlicí', 'Vysoké Mýto',
    'Lenka Eliášová', 'tajemstvijamu.cz', 'JAMU', 'Jamu',
    'Studio Oblouková', 'Masáže Isis', 'Joga studio Siddha', 'Masáže Zahrada života',
]
UNRESTORED_MARKER_RE = re.compile(r'Z\s*X\s*Q|X\s*Q\s*\d|Q\s*X\s*Z', re.I)


def stable_id(key: str) -> int:
    return int(hashlib.sha256(key.encode('utf-8')).hexdigest()[:15], 16)


def slugify(value: str) -> str:
    value = value.replace('ß', 'ss').replace('ł', 'l').replace('Ł', 'L')
    value = unicodedata.normalize('NFKD', value).encode('ascii', 'ignore').decode('ascii')
    value = re.sub(r'[^a-zA-Z0-9]+', '-', value.lower()).strip('-')
    return value[:180] or 'translation'


def plain_text(markup: str) -> str:
    text = re.sub(r'<!--.*?-->', ' ', markup, flags=re.S)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = html.unescape(text)
    return re.sub(r'\s+', ' ', text).strip()


def source_meta(row: dict) -> str:
    existing = plain_text(str(row.get('meta_description', '')))
    if existing:
        return existing[:180]
    candidate = plain_text(str(row.get('excerpt') or row.get('content') or ''))
    if len(candidate) <= 160:
        return candidate
    shortened = candidate[:157].rsplit(' ', 1)[0]
    return shortened + '…'


def choice_values(choices) -> list[dict]:
    if isinstance(choices, dict):
        values = choices.values()
    elif isinstance(choices, list):
        values = choices
    else:
        return []
    return [choice for choice in values if isinstance(choice, dict)]


def protect_text(value: str) -> str:
    protected = value
    for index, term in sorted(enumerate(PROTECTED_TERMS), key=lambda item: len(item[1]), reverse=True):
        marker = f'ZXQ{index}QXZ'
        pattern = r'(?<![\w])' + re.escape(term) + r'(?![\w])'
        protected = re.sub(pattern, marker, protected, flags=re.I)
    return protected


def restore_text(value: str) -> str:
    restored = value
    for index, term in enumerate(PROTECTED_TERMS):
        marker = r'Z\s*X\s*Q?\s*[-_\s]*' + str(index) + r'\s*Q?\s*X\s*Z'
        restored = re.sub(marker, term, restored, flags=re.I)
    return restored


def assert_no_unrestored_markers(rows: list[dict]) -> None:
    payload = json.dumps(rows, ensure_ascii=False)
    match = UNRESTORED_MARKER_RE.search(payload)
    if match:
        start = max(0, match.start() - 60)
        end = min(len(payload), match.end() + 60)
        snippet = payload[start:end]
        raise RuntimeError(f'Unrestored translation marker detected near: {snippet}')


def split_chunks(text: str, limit: int = 380) -> list[str]:
    text = text.strip()
    if len(text) <= limit:
        return [text]
    sentences = SENTENCE_RE.split(text)
    chunks: list[str] = []
    current = ''
    for sentence in sentences:
        if len(sentence) > limit:
            words = sentence.split()
            for word in words:
                if current and len(current) + len(word) + 1 > limit:
                    chunks.append(current)
                    current = ''
                current = f'{current} {word}'.strip()
            continue
        if current and len(current) + len(sentence) + 1 > limit:
            chunks.append(current)
            current = sentence
        else:
            current = f'{current} {sentence}'.strip()
    if current:
        chunks.append(current)
    return chunks


def visible_segments(markup: str) -> list[str]:
    pieces = TOKEN_RE.split(markup)
    result = []
    for index, piece in enumerate(pieces):
        if index % 2 == 1 or not piece.strip() or SHORTCODE_RE.match(piece):
            continue
        match = SPACE_RE.match(piece)
        core = match.group(2) if match else piece.strip()
        core = html.unescape(core)
        if re.search(r'[A-Za-zÁ-ž]', core) and not re.fullmatch(r'[\d\W_]+', core):
            result.append(core)
    return result


class Translator:
    def __init__(self, language: str):
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
        import torch

        config = MODEL_CONFIG[language]
        self.language = language
        self.torch = torch
        torch.set_num_threads(max(1, min(4, os.cpu_count() or 2)))
        self.stages = []
        for model_name, prefix in config['models']:
            tokenizer = AutoTokenizer.from_pretrained(model_name)
            model = AutoModelForSeq2SeqLM.from_pretrained(model_name)
            model.eval()
            self.stages.append((tokenizer, model, prefix))
        self.memory: dict[str, str] = {}

    def prepare(self, values: Iterable[str]) -> None:
        chunks = []
        for value in values:
            if not value or value in self.memory:
                continue
            for chunk in split_chunks(value):
                if chunk not in self.memory:
                    chunks.append(chunk)
        unique = sorted(set(chunks), key=lambda item: (len(item), item))
        batch_size = 16
        for start in range(0, len(unique), batch_size):
            batch = unique[start:start + batch_size]
            translated = [protect_text(item) for item in batch]
            for tokenizer, model, prefix in self.stages:
                inputs = [prefix + item for item in translated]
                encoded = tokenizer(
                    inputs, return_tensors='pt', padding=True, truncation=True, max_length=512
                )
                with self.torch.no_grad():
                    generated = model.generate(
                        **encoded,
                        max_new_tokens=512,
                        num_beams=3,
                        early_stopping=True,
                        renormalize_logits=True,
                    )
                translated = tokenizer.batch_decode(generated, skip_special_tokens=True)
            for source, target in zip(batch, translated):
                self.memory[source] = self.fix_glossary(source, restore_text(target.strip()))
            print(f'[{self.language}] translated {min(start + batch_size, len(unique))}/{len(unique)} segments', flush=True)

    def text(self, value: str) -> str:
        if not value:
            return ''
        chunks = split_chunks(value)
        return ' '.join(self.memory.get(chunk, chunk) for chunk in chunks).strip()

    def markup(self, markup: str) -> str:
        pieces = TOKEN_RE.split(markup)
        for index in range(0, len(pieces), 2):
            piece = pieces[index]
            if not piece.strip() or SHORTCODE_RE.match(piece):
                continue
            match = SPACE_RE.match(piece)
            if not match:
                continue
            leading, core, trailing = match.groups()
            decoded = html.unescape(core)
            if decoded in self.memory or len(split_chunks(decoded)) > 1:
                translated = self.text(decoded)
                pieces[index] = leading + html.escape(translated, quote=False) + trailing
        return ''.join(pieces)

    @staticmethod
    def fix_glossary(source: str, target: str) -> str:
        protected = ['Tajemství JAMU', 'JAMU', 'Jamu', 'Kutus Kutus', 'Minyak Balur', 'Bali', 'Ecomail', 'WooCommerce']
        for term in protected:
            if term in source and term.lower() not in target.lower():
                target = target.replace(term.lower(), term)
        return target


def collect_strings(inventory: dict, scope: str) -> set[str]:
    strings: set[str] = set()

    def add(value):
        if isinstance(value, str) and value.strip():
            strings.add(html.unescape(value.strip()))

    for row in inventory.get('posts', []):
        if row['object_subtype'] not in {'wp_template', 'wp_template_part', 'wp_navigation', 'wp_block'}:
            add(row.get('title', ''))
            add(source_meta(row))
            if scope == 'full':
                add(row.get('excerpt', ''))
                strings.update(visible_segments(row.get('content', '')))
    for row in inventory.get('terms', []):
        add(row.get('title', ''))
        add(source_meta(row))
        if scope == 'full':
            strings.update(visible_segments(row.get('content', '')))
    for row in inventory.get('block_templates', []):
        if row.get('source') == 'custom':
            add(row.get('title', ''))
            if scope == 'full':
                strings.update(visible_segments(row.get('content', '')))
    for form in inventory.get('forms', []):
        add(form.get('title', ''))
        for field in form.get('fields', {}).values():
            for key in ('label', 'description', 'placeholder', 'code'):
                value = field.get(key, '')
                if key == 'code' and scope == 'full':
                    strings.update(visible_segments(value))
                elif key != 'code':
                    add(value)
            for choice in choice_values(field.get('choices', [])):
                add(choice.get('label', ''))
        for value in form.get('settings', {}).values():
            add(value)
    add(inventory.get('site_strings', {}).get('description', ''))
    for media in inventory.get('media', []):
        alt = media.get('alt') or ''
        if alt:
            add(alt)
    for post in inventory.get('posts', []):
        if post.get('object_subtype') != 'wp_navigation':
            continue
        for match in re.finditer(r'<!-- wp:navigation-(?:link|submenu)\s+(\{.*?\})\s*(?:/)?-->', post.get('content', '')):
            try:
                attributes = json.loads(match.group(1))
            except json.JSONDecodeError:
                continue
            add(attributes.get('label', ''))
    return strings


def unique_routes(rows: list[dict], language: str) -> dict[tuple[str, int], str]:
    used: set[tuple[str, str]] = set()
    slugs: dict[tuple[str, int], str] = {}
    for row in rows:
        subtype = row.get('object_subtype', '')
        object_id = int(row['object_id'])
        candidate = slugify(row.get('_translated_title') or row.get('title') or row.get('slug') or str(object_id))
        key = (subtype, candidate)
        if key in used:
            candidate = f'{candidate}-{object_id}'
        used.add((subtype, candidate))
        slugs[(row.get('object_type', 'post'), object_id)] = candidate

    by_id = {(row.get('object_type', 'post'), int(row['object_id'])): row for row in rows}
    routes = {}
    for row in rows:
        object_id = int(row['object_id'])
        slug = slugs[(row.get('object_type', 'post'), object_id)]
        parts = [slug]
        object_type = row.get('object_type', 'post')
        parent = int(row.get('parent') or 0)
        seen = {object_id}
        while parent and (object_type, parent) in by_id and parent not in seen:
            seen.add(parent)
            parent_row = by_id[(object_type, parent)]
            parent_slug = slugs.get((parent_row.get('object_type', 'post'), parent))
            if parent_slug:
                parts.insert(0, parent_slug)
            parent = int(parent_row.get('parent') or 0)
        routes[(row.get('object_type', 'post'), object_id)] = '/'.join(parts)
    return routes


def title_for(source: dict, translator: Translator, overrides: dict) -> str:
    object_type = source.get('object_type', 'post')
    override = overrides.get(translator.language, {}).get(object_type, {}).get(str(source['object_id']))
    if override:
        return override
    return translator.text(source.get('title') or source.get('slug', ''))


def build_rows(inventory: dict, translator: Translator, scope: str, overrides: dict) -> list[dict]:
    rows: list[dict] = []
    route_sources = []
    source_urls = {}

    for source in inventory.get('posts', []):
        subtype = source['object_subtype']
        if subtype in {'wp_template', 'wp_template_part', 'wp_navigation', 'wp_block'}:
            continue
        row = dict(source)
        row['_translated_title'] = title_for(source, translator, overrides)
        route_sources.append(row)
    for source in inventory.get('terms', []):
        row = dict(source)
        row['_translated_title'] = title_for(source, translator, overrides)
        route_sources.append(row)

    routes = unique_routes(route_sources, translator.language)
    for source in inventory.get('posts', []):
        subtype = source['object_subtype']
        if subtype in {'wp_template', 'wp_template_part', 'wp_navigation', 'wp_block'}:
            continue
        title = title_for(source, translator, overrides)
        route = routes.get(('post', int(source['object_id'])), slugify(title))
        translated = {
            'object_type': 'post', 'object_subtype': subtype,
            'object_id': int(source['object_id']), 'language': translator.language,
            'route_path': route, 'slug': route.rsplit('/', 1)[-1],
            'title': title,
            'excerpt': translator.markup(source.get('excerpt', '')) if scope == 'full' else '',
            'content': translator.markup(source.get('content', '')) if scope == 'full' else '',
            'seo_title': title,
            'meta_description': translator.text(source_meta(source)),
            'data': {}, 'status': 'publish' if scope == 'full' else 'draft',
        }
        rows.append(translated)
        if source.get('url'):
            source_urls[source['url'].rstrip('/') + '/'] = translated

    for source in inventory.get('terms', []):
        title = title_for(source, translator, overrides)
        route = routes.get(('term', int(source['object_id'])), slugify(title))
        translated = {
            'object_type': 'term', 'object_subtype': source['object_subtype'],
            'object_id': int(source['object_id']), 'language': translator.language,
            'route_path': route, 'slug': route.rsplit('/', 1)[-1],
            'title': title, 'excerpt': '',
            'content': translator.markup(source.get('content', '')) if scope == 'full' else '',
            'seo_title': title,
            'meta_description': translator.text(source_meta(source)),
            'data': {}, 'status': 'publish' if scope == 'full' else 'draft',
        }
        rows.append(translated)
        if source.get('url') and source['object_subtype'] in {'product_cat', 'product_tag'}:
            source_urls[source['url'].rstrip('/') + '/'] = translated

    if scope == 'full':
        for source in inventory.get('block_templates', []):
            if source.get('source') != 'custom':
                continue
            content = translator.markup(source.get('content', ''))
            content = rewrite_internal_links(content, source_urls, translator.language, inventory)
            rows.append({
                'object_type': 'template', 'object_subtype': source['object_subtype'],
                'object_id': int(source['object_id']), 'language': translator.language,
                'route_path': '', 'slug': source.get('slug', ''),
                'title': translator.text(source.get('title', '')), 'excerpt': '',
                'content': content, 'seo_title': '', 'meta_description': '',
                'data': {'template_id': source.get('template_id', '')}, 'status': 'publish',
            })

    for form in inventory.get('forms', []):
        fields = {}
        for field_id, field in form.get('fields', {}).items():
            translated_field = {}
            for key in ('label', 'description', 'placeholder'):
                if field.get(key):
                    translated_field[key] = translator.text(str(field[key]))
            if field.get('code') and scope == 'full':
                translated_field['code'] = translator.markup(str(field['code']))
            choices = choice_values(field.get('choices'))
            if choices:
                translated_field['choices'] = [
                    {'label': translator.text(str(choice.get('label', ''))), 'value': choice.get('value', '')}
                    for choice in choices
                ]
            fields[str(field_id)] = translated_field
        settings = {key: translator.text(str(value)) for key, value in form.get('settings', {}).items() if value}
        rows.append({
            'object_type': 'form', 'object_subtype': 'wpforms',
            'object_id': int(form['object_id']), 'language': translator.language,
            'route_path': '', 'slug': '', 'title': translator.text(form.get('title', '')),
            'excerpt': '', 'content': '', 'seo_title': '', 'meta_description': '',
            'data': {'fields': fields, 'settings': settings},
            'status': 'publish' if scope == 'full' else 'draft',
        })

    for media in inventory.get('media', []):
        alt = str(media.get('alt') or '')
        if not alt:
            continue
        rows.append({
            'object_type': 'attachment', 'object_subtype': 'image',
            'object_id': int(media['object_id']), 'language': translator.language,
            'route_path': '', 'slug': '', 'title': '', 'excerpt': '', 'content': '',
            'seo_title': '', 'meta_description': '', 'data': {'alt': translator.text(alt)},
            'status': 'publish' if scope == 'full' else 'draft',
        })

    rows.append({
        'object_type': 'option', 'object_subtype': 'site',
        'object_id': stable_id('option:blogname'), 'language': translator.language,
        'route_path': '', 'slug': 'blogname', 'title': inventory.get('site_strings', {}).get('name', 'Tajemství JAMU'),
        'excerpt': '', 'content': '', 'seo_title': '', 'meta_description': '', 'data': {},
        'status': 'publish' if scope == 'full' else 'draft',
    })
    rows.append({
        'object_type': 'option', 'object_subtype': 'site',
        'object_id': stable_id('option:blogdescription'), 'language': translator.language,
        'route_path': '', 'slug': 'blogdescription',
        'title': translator.text(inventory.get('site_strings', {}).get('description', '')),
        'excerpt': '', 'content': '', 'seo_title': '', 'meta_description': '', 'data': {},
        'status': 'publish' if scope == 'full' else 'draft',
    })

    add_navigation_strings(rows, inventory, translator, source_urls, scope)
    return rows


def localized_url(row: dict, language: str, inventory: dict) -> str:
    prefix = {'en': 'en', 'de': 'de', 'pl': 'pl'}[language]
    subtype = row['object_subtype']
    if subtype == 'product':
        base = {'en': 'product', 'de': 'produkt', 'pl': 'produkt'}[language]
        return f'https://tajemstvijamu.cz/{prefix}/{base}/{row["route_path"]}/'
    if subtype == 'product_cat':
        base = {'en': 'product-category', 'de': 'produkt-kategorie', 'pl': 'kategoria-produktu'}[language]
        return f'https://tajemstvijamu.cz/{prefix}/{base}/{row["route_path"]}/'
    if subtype == 'product_tag':
        base = {'en': 'product-tag', 'de': 'produkt-schlagwort', 'pl': 'tag-produktu'}[language]
        return f'https://tajemstvijamu.cz/{prefix}/{base}/{row["route_path"]}/'
    return f'https://tajemstvijamu.cz/{prefix}/{row["route_path"]}/'


def rewrite_internal_links(content: str, source_urls: dict, language: str, inventory: dict) -> str:
    for source_url, row in sorted(source_urls.items(), key=lambda item: len(item[0]), reverse=True):
        content = content.replace(source_url, localized_url(row, language, inventory))
        content = content.replace(source_url.rstrip('/'), localized_url(row, language, inventory).rstrip('/'))
    return content


def add_navigation_strings(rows: list[dict], inventory: dict, translator: Translator, source_urls: dict, scope: str) -> None:
    for post in inventory.get('posts', []):
        if post.get('object_subtype') != 'wp_navigation':
            continue
        for match in re.finditer(r'<!-- wp:navigation-(?:link|submenu)\s+(\{.*?\})\s*(?:/)?-->', post.get('content', '')):
            try:
                attributes = json.loads(match.group(1))
            except json.JSONDecodeError:
                continue
            if attributes.get('id') and attributes.get('kind') in {'post-type', 'taxonomy'}:
                continue
            label = str(attributes.get('label', ''))
            url = str(attributes.get('url', ''))
            if not label:
                continue
            translated_url = url
            normalized = url.rstrip('/') + '/' if url else ''
            if normalized in source_urls:
                translated_url = localized_url(source_urls[normalized], translator.language, inventory)
            key = 'navigation:' + label + '|' + url
            rows.append({
                'object_type': 'string', 'object_subtype': 'navigation',
                'object_id': stable_id(key), 'language': translator.language,
                'route_path': '', 'slug': '', 'title': translator.text(label),
                'excerpt': '', 'content': '', 'seo_title': '', 'meta_description': '',
                'data': {'url': translated_url}, 'status': 'publish' if scope == 'full' else 'draft',
            })


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--language', required=True, choices=sorted(MODEL_CONFIG))
    parser.add_argument('--scope', default='titles', choices=['titles', 'full'])
    parser.add_argument('--input', default='jamu-content/source-inventory.json')
    parser.add_argument('--overrides', default='jamu-content/title-overrides.json')
    parser.add_argument('--output')
    args = parser.parse_args()

    inventory = json.loads(Path(args.input).read_text(encoding='utf-8'))
    overrides_path = Path(args.overrides)
    overrides = json.loads(overrides_path.read_text(encoding='utf-8')) if overrides_path.exists() else {}
    translator = Translator(args.language)
    strings = collect_strings(inventory, args.scope)
    translator.prepare(strings)
    rows = build_rows(inventory, translator, args.scope, overrides)
    assert_no_unrestored_markers(rows)
    output = Path(args.output or f'jamu-content/translations-{args.language}.json')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        'schema': 1,
        'source_generated_at': inventory.get('generated_at'),
        'language': args.language,
        'language_name': LANGUAGE_NAMES[args.language],
        'scope': args.scope,
        'model': ' -> '.join(model for model, prefix in MODEL_CONFIG[args.language]['models']),
        'translations': rows,
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Wrote {len(rows)} {args.language} translation rows to {output}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
