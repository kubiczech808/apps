from __future__ import annotations

import json
from pathlib import Path


def main() -> int:
    documents = []
    rows = []
    for path in sorted(Path('jamu-content/generated').glob('translations-*.json')):
        document = json.loads(path.read_text(encoding='utf-8'))
        documents.append({
            'language': document['language'],
            'scope': document['scope'],
            'model': document['model'],
            'rows': len(document['translations']),
        })
        rows.extend(document['translations'])
    if not documents:
        raise RuntimeError('No generated translation files found.')
    output = {
        'schema': 1,
        'generator': 'JAMU open-source OPUS-MT pipeline',
        'documents': documents,
        'translations': rows,
    }
    Path('jamu-content/translations-draft.json').write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8'
    )
    print(json.dumps(documents, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

