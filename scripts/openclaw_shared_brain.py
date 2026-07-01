#!/usr/bin/env python3
"""OpenClaw Shared Brain.

Local Markdown knowledge graph and lightweight retrieval service inspired by
HumanAgentWiki. It intentionally has a dependency-free fallback backend so it can
run safely on the Raspberry Pi before a pgvector/BGE-M3 backend is provisioned.

Tools:
- brain_search
- brain_get
- brain_neighbors
- brain_put
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import http.server
import html
import json
import math
import os
import re
import subprocess
import sys
import unicodedata
import urllib.parse
from pathlib import Path
from typing import Any


OPENCLAW_DIR = Path(os.environ.get("OPENCLAW_DIR", "/home/openclaw2/.openclaw"))
BRAIN_DIR = Path(os.environ.get("OPENCLAW_BRAIN_DIR", str(OPENCLAW_DIR / "shared-brain")))
NOTES_DIR = Path(os.environ.get("OPENCLAW_BRAIN_NOTES_DIR", str(BRAIN_DIR / "notes")))
INDEX_PATH = Path(os.environ.get("OPENCLAW_BRAIN_INDEX", str(BRAIN_DIR / "index.json")))
LOG_PATH = OPENCLAW_DIR / "logs" / "openclaw-shared-brain.log"
HOST = os.environ.get("OPENCLAW_BRAIN_HOST", "127.0.0.1")
PORT = int(os.environ.get("OPENCLAW_BRAIN_PORT", "8812"))
PUBLIC_URL = os.environ.get("OPENCLAW_BRAIN_PUBLIC_URL", f"http://{HOST}:{PORT}").rstrip("/")

HEADER_RE = re.compile(r"^(#{2,3})\s+(.*)$")
LINK_RE = re.compile(r"\[\[([^\]]+?)\]\]")
WORD_RE = re.compile(r"[a-z0-9][a-z0-9._-]{1,}", re.IGNORECASE)
SKIP_DIRS = {".git", ".obsidian", "node_modules", "__pycache__"}
MIN_CHUNK_CHARS = 25


def log(message: str) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(f"[{stamp}] {message}\n")


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", str(text or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return text.lower()


def tokens(text: str) -> list[str]:
    return [m.group(0) for m in WORD_RE.finditer(normalize(text))]


def slugify(text: str) -> str:
    words = tokens(text)
    slug = "-".join(words[:10]).strip("-")
    return slug or "note"


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_frontmatter(raw: str) -> tuple[dict[str, str], str]:
    if not raw.startswith("---"):
        return {}, raw
    end = raw.find("\n---", 3)
    if end == -1:
        return {}, raw
    meta: dict[str, str] = {}
    for line in raw[3:end].splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        meta[key.strip()] = value.strip().strip('"').strip("'")
    return meta, raw[end + 4 :]


def split_blocks(body: str) -> list[tuple[str | None, str]]:
    blocks: list[tuple[str | None, str]] = []
    current_header: str | None = None
    buf: list[str] = []

    def flush() -> None:
        nonlocal buf, current_header
        content = "\n".join(buf).strip()
        if content or current_header:
            blocks.append((current_header, content))

    for line in body.splitlines():
        match = HEADER_RE.match(line)
        if match:
            flush()
            current_header = match.group(2).strip()
            buf = []
        else:
            buf.append(line)
    flush()
    return blocks


def category_for(path: Path, meta: dict[str, str]) -> str:
    if meta.get("category"):
        return meta["category"]
    rel = path.relative_to(NOTES_DIR)
    return rel.parts[0] if len(rel.parts) > 1 else "Notes"


def read_note_chunks(path: Path) -> list[dict[str, Any]]:
    rel = str(path.relative_to(NOTES_DIR)).replace("\\", "/")
    raw = path.read_text(encoding="utf-8", errors="replace")
    meta, body = parse_frontmatter(raw)
    file_title = meta.get("title") or path.stem
    category = category_for(path, meta)
    node_type = meta.get("type") or "note"
    tags = [item.strip() for item in re.split(r"[, ]+", meta.get("tags", "")) if item.strip()]
    chunks: list[dict[str, Any]] = []
    for header, content in split_blocks(body):
        full = f"{header}\n{content}".strip() if header else content.strip()
        if len(full) < MIN_CHUNK_CHARS:
            continue
        title = header or file_title
        chunks.append({
            "id": f"{rel}#{len(chunks) + 1}",
            "file": rel,
            "category": category,
            "node_type": node_type,
            "title": title[:200],
            "links": LINK_RE.findall(full),
            "tags": tags,
            "text": full,
            "meta": meta,
            "hash": file_hash(path),
        })
    if not chunks:
        text = (file_title + "\n" + body).strip() or file_title
        chunks.append({
            "id": f"{rel}#1",
            "file": rel,
            "category": category,
            "node_type": node_type,
            "title": file_title[:200],
            "links": LINK_RE.findall(body),
            "tags": tags,
            "text": text,
            "meta": meta,
            "hash": file_hash(path),
        })
    return chunks


def list_markdown_files() -> list[Path]:
    if not NOTES_DIR.exists():
        return []
    files: list[Path] = []
    for path in NOTES_DIR.rglob("*.md"):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        files.append(path)
    return sorted(files)


def ensure_seed_notes() -> None:
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    seeds = {
        NOTES_DIR / "System" / "OpenClaw Shared Brain.md": """---
title: OpenClaw Shared Brain
category: System
type: hub
tags: openclaw, agents, memory
---

# OpenClaw Shared Brain

This is the shared local memory for OpenClaw agents.

Agents should search it before answering questions that depend on project
history, preferences, agent responsibilities, long-running tasks or prior
decisions.

Core tools:
- [[brain_search]] for retrieval
- [[brain_get]] for exact note reads
- [[brain_neighbors]] for wiki graph links
- [[brain_put]] for saving durable facts and decisions
""",
        NOTES_DIR / "System" / "Agent Routing.md": """---
title: Agent Routing
category: System
tags: openclaw, agents, routing
---

# Agent Routing

Virtualni asistentka coordinates tasks across agents. Routing should be based
on current agent capability and target channel, not only historical names.

Known channel principles:
- WordPress/blog tasks go to the blogger instance matching the target domain.
- X/social tasks for btc-dca.com go to Agent D.
- Medium/DEV/Hashnode tasks go to Agent M.
- Runtime, deployment, auth and service blockers go to Agent G.
""",
    }
    for path, content in seeds.items():
        if path.exists():
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content.strip() + "\n", encoding="utf-8")


def build_index() -> dict[str, Any]:
    ensure_seed_notes()
    chunks: list[dict[str, Any]] = []
    files: dict[str, str] = {}
    for path in list_markdown_files():
        rel = str(path.relative_to(NOTES_DIR)).replace("\\", "/")
        files[rel] = file_hash(path)
        try:
            chunks.extend(read_note_chunks(path))
        except Exception as exc:
            log(f"index skip {path}: {type(exc).__name__}: {exc}")
    doc_freq: dict[str, int] = {}
    for chunk in chunks:
        chunk_tokens = tokens(" ".join([
            str(chunk.get("title") or ""),
            str(chunk.get("category") or ""),
            str(chunk.get("text") or ""),
            " ".join(chunk.get("tags") or []),
        ]))
        counts: dict[str, int] = {}
        for token in chunk_tokens:
            counts[token] = counts.get(token, 0) + 1
        chunk["token_counts"] = counts
        chunk["token_len"] = sum(counts.values()) or 1
        for token in counts:
            doc_freq[token] = doc_freq.get(token, 0) + 1
    return {
        "generated_at": now_iso(),
        "backend": "openclaw-lite-hybrid",
        "notes_dir": str(NOTES_DIR),
        "chunk_count": len(chunks),
        "file_count": len(files),
        "files": files,
        "doc_freq": doc_freq,
        "chunks": chunks,
    }


def load_index(refresh: bool = False) -> dict[str, Any]:
    if refresh or not INDEX_PATH.exists():
        return write_index()
    try:
        return json.loads(INDEX_PATH.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return write_index()


def write_index() -> dict[str, Any]:
    BRAIN_DIR.mkdir(parents=True, exist_ok=True)
    index = build_index()
    INDEX_PATH.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    log(f"indexed files={index['file_count']} chunks={index['chunk_count']}")
    return index


def idf(index: dict[str, Any], token: str) -> float:
    total = max(int(index.get("chunk_count") or 1), 1)
    df = int((index.get("doc_freq") or {}).get(token) or 0)
    return math.log((total + 1) / (df + 1)) + 1.0


def hit_for(chunk: dict[str, Any], score: float) -> dict[str, Any]:
    text = str(chunk.get("text") or "")
    snippet = text[:500] + ("..." if len(text) > 500 else "")
    return {
        "id": chunk.get("id"),
        "file": chunk.get("file"),
        "category": chunk.get("category"),
        "node_type": chunk.get("node_type"),
        "title": chunk.get("title"),
        "links": chunk.get("links") or [],
        "tags": chunk.get("tags") or [],
        "score": round(float(score), 6),
        "snippet": snippet,
    }


def brain_search(query: str, k: int = 8, category: str = "", node_type: str = "") -> list[dict[str, Any]]:
    index = load_index()
    query_tokens = tokens(query)
    if not query_tokens:
        return []
    query_counts: dict[str, int] = {}
    for token in query_tokens:
        query_counts[token] = query_counts.get(token, 0) + 1
    query_norm = math.sqrt(sum((count * idf(index, token)) ** 2 for token, count in query_counts.items())) or 1.0
    scored: list[tuple[float, dict[str, Any]]] = []
    phrase = normalize(query)
    for chunk in index.get("chunks") or []:
        if category and normalize(chunk.get("category", "")) != normalize(category):
            continue
        if node_type and normalize(chunk.get("node_type", "")) != normalize(node_type):
            continue
        counts = chunk.get("token_counts") or {}
        doc_norm = math.sqrt(sum((count * idf(index, token)) ** 2 for token, count in counts.items())) or 1.0
        cosine = 0.0
        keyword = 0.0
        for token, qcount in query_counts.items():
            if token not in counts:
                continue
            weight = idf(index, token)
            cosine += (qcount * weight) * (counts[token] * weight)
            keyword += min(counts[token], qcount) * weight
        cosine = cosine / (query_norm * doc_norm)
        haystack = normalize(" ".join([
            str(chunk.get("title") or ""),
            str(chunk.get("file") or ""),
            str(chunk.get("category") or ""),
            str(chunk.get("text") or ""),
        ]))
        phrase_bonus = 1.5 if phrase and phrase in haystack else 0.0
        title_bonus = 0.35 if any(token in tokens(str(chunk.get("title") or "")) for token in query_counts) else 0.0
        score = cosine * 3.0 + keyword * 0.35 + phrase_bonus + title_bonus
        if score > 0:
            scored.append((score, chunk))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [hit_for(chunk, score) for score, chunk in scored[: max(1, min(int(k or 8), 50))]]


def brain_get(title_or_file: str) -> list[dict[str, Any]]:
    index = load_index()
    needle = normalize(title_or_file)
    out: list[dict[str, Any]] = []
    for chunk in index.get("chunks") or []:
        title = normalize(chunk.get("title", ""))
        file = normalize(chunk.get("file", ""))
        if needle in {title, file} or needle == file.removesuffix(".md"):
            row = dict(chunk)
            row.pop("token_counts", None)
            row.pop("token_len", None)
            out.append(row)
    return out[:25]


def brain_neighbors(name: str, k: int = 15) -> dict[str, Any]:
    index = load_index()
    needle = normalize(name)
    outgoing: list[str] = []
    incoming: list[dict[str, Any]] = []
    for chunk in index.get("chunks") or []:
        title = normalize(chunk.get("title", ""))
        file = normalize(chunk.get("file", ""))
        if needle in {title, file} or needle == file.removesuffix(".md"):
            outgoing.extend(chunk.get("links") or [])
    for chunk in index.get("chunks") or []:
        links = [normalize(link) for link in chunk.get("links") or []]
        if needle in links:
            incoming.append({
                "title": chunk.get("title"),
                "file": chunk.get("file"),
                "category": chunk.get("category"),
            })
    return {"links_to": sorted(set(outgoing)), "linked_from": incoming[: max(1, int(k or 15))]}


def brain_put(category: str, title: str, text: str, source: str = "agent") -> dict[str, Any]:
    ensure_seed_notes()
    safe_category = slugify(category or "Notes")
    safe_title = slugify(title)
    folder = NOTES_DIR / safe_category
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{safe_title}.md"
    if path.exists():
        existing = path.read_text(encoding="utf-8", errors="replace").rstrip()
        content = f"{existing}\n\n## Update {now_iso()}\n\n{text.strip()}\n"
    else:
        content = "\n".join([
            "---",
            f"title: {title}",
            f"category: {category or 'Notes'}",
            f"source: {source}",
            f"created_at: {now_iso()}",
            "---",
            "",
            f"# {title}",
            "",
            text.strip(),
            "",
        ])
    path.write_text(content, encoding="utf-8")
    write_index()
    try_git_commit(path, f"brain: update {title}")
    return {"ok": True, "file": str(path.relative_to(NOTES_DIR)).replace("\\", "/")}


def try_git_commit(path: Path, message: str) -> None:
    try:
        if not (BRAIN_DIR / ".git").exists():
            subprocess.run(["git", "init"], cwd=str(BRAIN_DIR), check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["git", "add", str(path), str(INDEX_PATH)], cwd=str(BRAIN_DIR), check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["git", "commit", "-m", message], cwd=str(BRAIN_DIR), check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as exc:
        log(f"git commit skipped: {type(exc).__name__}: {exc}")


def compact_context(query: str, k: int = 5) -> str:
    hits = brain_search(query, k=k)
    if not hits:
        return "SHARED BRAIN CONTEXT: no relevant notes found."
    lines = ["SHARED BRAIN CONTEXT:"]
    for hit in hits:
        lines.append(f"- [{hit['category']}] {hit['title']} ({hit['file']}): {hit['snippet']}")
    return "\n".join(lines)


def json_response(handler: http.server.BaseHTTPRequestHandler, status: int, data: Any) -> None:
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def text_response(handler: http.server.BaseHTTPRequestHandler, status: int, body: str, content_type: str = "text/html; charset=utf-8") -> None:
    data = body.encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def note_nodes(index: dict[str, Any]) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}
    for chunk in index.get("chunks") or []:
        file = str(chunk.get("file") or "")
        if not file:
            continue
        node = seen.setdefault(file, {
            "id": file,
            "title": str((chunk.get("meta") or {}).get("title") or Path(file).stem),
            "category": chunk.get("category"),
            "node_type": chunk.get("node_type"),
            "tags": chunk.get("tags") or [],
            "chunks": 0,
            "links": [],
        })
        node["chunks"] += 1
        node["links"].extend(chunk.get("links") or [])
    for node in seen.values():
        node["links"] = sorted(set(node["links"]))
    return sorted(seen.values(), key=lambda item: str(item.get("id") or ""))


def brain_graph(index: dict[str, Any]) -> dict[str, Any]:
    nodes = note_nodes(index)
    by_title = {normalize(node["title"]): node["id"] for node in nodes}
    by_stem = {normalize(Path(node["id"]).stem): node["id"] for node in nodes}
    edges: list[dict[str, str]] = []
    for node in nodes:
        for link in node.get("links") or []:
            target = by_title.get(normalize(link)) or by_stem.get(normalize(link)) or link
            edges.append({"source": node["id"], "target": target, "label": link})
    return {
        "generated_at": index.get("generated_at"),
        "nodes": nodes,
        "edges": edges,
        "tools": [tool["name"] for tool in tool_schemas()],
        "notes_dir": str(NOTES_DIR),
        "agent_visible_base_url": f"http://{HOST}:{PORT}",
        "public_url": PUBLIC_URL,
    }


def note_list_html() -> str:
    index = load_index()
    rows = []
    for node in note_nodes(index):
        url = "/note?file=" + urllib.parse.quote(node["id"])
        rows.append(
            "<tr>"
            f"<td><a href='{url}'>{html.escape(node['title'])}</a></td>"
            f"<td>{html.escape(str(node.get('category') or ''))}</td>"
            f"<td>{html.escape(str(node.get('node_type') or ''))}</td>"
            f"<td>{html.escape(str(node.get('chunks') or 0))}</td>"
            f"<td>{html.escape(', '.join(node.get('links') or []))}</td>"
            "</tr>"
        )
    return "\n".join(rows)


def note_detail_html(file_name: str) -> str:
    index = load_index()
    chunks = [chunk for chunk in index.get("chunks") or [] if str(chunk.get("file") or "") == file_name]
    if not chunks:
        return "<p>Note not found.</p>"
    parts = []
    for chunk in chunks:
        title = html.escape(str(chunk.get("title") or ""))
        text = html.escape(str(chunk.get("text") or ""))
        parts.append(f"<article><h2>{title}</h2><pre>{text}</pre></article>")
    return "\n".join(parts)


def brain_page_shell(title: str, body: str) -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(title)}</title>
  <style>
    body {{ font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 32px auto; max-width: 980px; padding: 0 18px; line-height: 1.5; }}
    a {{ color: #0d6b4f; }}
    pre {{ white-space: pre-wrap; background: #f5f7f5; border: 1px solid #dbe2dd; padding: 12px; border-radius: 6px; }}
  </style>
</head>
<body>
  <p><a href="/">Back to Shared Brain</a></p>
  <h1>{html.escape(title)}</h1>
  {body}
</body>
</html>"""


def brain_index_html() -> str:
    index = load_index()
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenClaw Shared Brain</title>
  <style>
    :root {{ color-scheme: light dark; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }}
    body {{ margin: 0; background: #f7f7f4; color: #202124; }}
    header {{ padding: 24px 32px; background: #10201b; color: #f6fff7; }}
    main {{ padding: 24px 32px 48px; max-width: 1180px; margin: auto; }}
    .bar {{ display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 16px 0 24px; }}
    a.button {{ color: #0b3d2e; border: 1px solid #8ab9a5; background: #eff8f3; padding: 8px 10px; border-radius: 6px; text-decoration: none; }}
    table {{ width: 100%; border-collapse: collapse; background: white; }}
    th, td {{ text-align: left; border-bottom: 1px solid #ddd; padding: 10px; vertical-align: top; }}
    th {{ background: #eef2ee; }}
    code {{ background: #eef2ee; padding: 2px 4px; border-radius: 4px; }}
    pre {{ white-space: pre-wrap; background: #fff; border: 1px solid #ddd; padding: 12px; border-radius: 6px; }}
    #graph {{ min-height: 440px; border: 1px solid #d5ddd8; background: white; border-radius: 6px; overflow: hidden; }}
    .node {{ cursor: pointer; }}
    .edge {{ stroke: #8aa096; stroke-width: 1.4; }}
    @media (prefers-color-scheme: dark) {{
      body {{ background: #151716; color: #e8eee9; }}
      table, #graph, pre {{ background: #202522; border-color: #3a4540; }}
      th, code {{ background: #26322d; }}
      td, th {{ border-bottom-color: #3a4540; }}
      a.button {{ color: #bfe7d4; background: #1c2c26; border-color: #476b5c; }}
    }}
  </style>
</head>
<body>
<header>
  <h1>OpenClaw Shared Brain</h1>
  <p>Local Markdown knowledge graph for OpenClaw agents.</p>
</header>
<main>
  <section>
    <h2>Status</h2>
    <p>Backend: <code>{html.escape(str(index.get('backend')))}</code> · Files: <code>{index.get('file_count')}</code> · Chunks: <code>{index.get('chunk_count')}</code></p>
    <p>Public/Tailscale URL: <code>{html.escape(PUBLIC_URL)}</code></p>
    <p>Notes dir: <code>{html.escape(str(NOTES_DIR))}</code></p>
    <div class="bar">
      <a class="button" href="/graph">Visual graph</a>
      <a class="button" href="/graph.json">Graph JSON</a>
      <a class="button" href="/tools">Tool schemas</a>
      <a class="button" href="/health">Health JSON</a>
      <a class="button" href="/agent-view">Agent view</a>
    </div>
  </section>
  <section>
    <h2>Notes</h2>
    <table>
      <thead><tr><th>Title</th><th>Category</th><th>Type</th><th>Chunks</th><th>Outgoing links</th></tr></thead>
      <tbody>{note_list_html()}</tbody>
    </table>
  </section>
</main>
</body>
</html>"""


def brain_graph_html() -> str:
    return """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenClaw Shared Brain Graph</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: #f6f7f5; color: #202124; }
    header { padding: 18px 24px; background: #10201b; color: #f6fff7; }
    main { padding: 18px 24px; }
    #graph { width: 100%; height: calc(100vh - 150px); min-height: 520px; background: white; border: 1px solid #d9dfdb; border-radius: 6px; }
    .edge { stroke: #90a39a; stroke-width: 1.5; }
    .node circle { fill: #0d6b4f; stroke: #f9fffb; stroke-width: 2; }
    .node text { font-size: 12px; fill: #202124; paint-order: stroke; stroke: #fff; stroke-width: 3px; stroke-linejoin: round; }
    a { color: inherit; }
  </style>
</head>
<body>
<header><h1>OpenClaw Shared Brain Graph</h1><a href="/">Back to notes</a></header>
<main><svg id="graph"></svg></main>
<script>
async function loadGraph() {
  const data = await fetch('/graph.json').then(r => r.json());
  const svg = document.getElementById('graph');
  const width = svg.clientWidth || 1000;
  const height = svg.clientHeight || 600;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const nodes = data.nodes.map((n, i) => ({...n, x: width/2 + Math.cos(i)*180, y: height/2 + Math.sin(i)*140}));
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const edge of data.edges) {
    if (!byId.has(edge.target)) {
      const n = {id: edge.target, title: edge.label || edge.target, category: 'Linked', x: Math.random()*width, y: Math.random()*height};
      nodes.push(n); byId.set(n.id, n);
    }
  }
  const edges = data.edges.map(e => ({source: byId.get(e.source), target: byId.get(e.target), label: e.label})).filter(e => e.source && e.target);
  function step() {
    for (const n of nodes) { n.vx = (n.vx || 0) * 0.85; n.vy = (n.vy || 0) * 0.85; }
    for (let i=0; i<nodes.length; i++) for (let j=i+1; j<nodes.length; j++) {
      const a = nodes[i], b = nodes[j], dx = a.x-b.x, dy = a.y-b.y, d2 = Math.max(dx*dx+dy*dy, 80);
      const f = 900 / d2; a.vx += dx*f; a.vy += dy*f; b.vx -= dx*f; b.vy -= dy*f;
    }
    for (const e of edges) {
      const dx = e.target.x-e.source.x, dy = e.target.y-e.source.y, dist = Math.max(Math.hypot(dx,dy), 1), desired = 170;
      const f = (dist-desired)*0.008; const fx=dx/dist*f, fy=dy/dist*f;
      e.source.vx += fx; e.source.vy += fy; e.target.vx -= fx; e.target.vy -= fy;
    }
    for (const n of nodes) {
      n.vx += (width/2-n.x)*0.002; n.vy += (height/2-n.y)*0.002;
      n.x = Math.max(24, Math.min(width-24, n.x+n.vx)); n.y = Math.max(24, Math.min(height-24, n.y+n.vy));
    }
  }
  for (let i=0; i<240; i++) step();
  svg.innerHTML = '';
  for (const e of edges) {
    const line = document.createElementNS('http://www.w3.org/2000/svg','line');
    line.setAttribute('class','edge'); line.setAttribute('x1',e.source.x); line.setAttribute('y1',e.source.y); line.setAttribute('x2',e.target.x); line.setAttribute('y2',e.target.y); svg.appendChild(line);
  }
  for (const n of nodes) {
    const g = document.createElementNS('http://www.w3.org/2000/svg','g'); g.setAttribute('class','node');
    g.setAttribute('transform', `translate(${n.x},${n.y})`);
    const c = document.createElementNS('http://www.w3.org/2000/svg','circle'); c.setAttribute('r', n.category === 'Linked' ? 7 : 10);
    const t = document.createElementNS('http://www.w3.org/2000/svg','text'); t.setAttribute('x',14); t.setAttribute('y',4); t.textContent = n.title || n.id;
    g.appendChild(c); g.appendChild(t);
    g.addEventListener('click', () => { if (!n.id.endsWith('.md')) return; location.href = '/note?file=' + encodeURIComponent(n.id); });
    svg.appendChild(g);
  }
}
loadGraph();
</script>
</body>
</html>"""


def agent_view_html() -> str:
    index = load_index()
    tools = ", ".join(tool["name"] for tool in tool_schemas())
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenClaw Shared Brain Agent View</title>
<style>body{{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:900px;margin:32px auto;padding:0 18px;line-height:1.5}}code,pre{{background:#f0f3f1;padding:2px 4px;border-radius:4px}}pre{{padding:12px;white-space:pre-wrap}}</style>
</head><body>
<h1>What agents can see</h1>
<p>OpenClaw agents can read the shared brain locally at <code>http://127.0.0.1:{PORT}</code>.</p>
<p>Human/Tailscale view: <code>{html.escape(PUBLIC_URL)}</code>.</p>
<p>Available tools: <code>{html.escape(tools)}</code>.</p>
<p>Notes directory: <code>{html.escape(str(NOTES_DIR))}</code>.</p>
<p>Indexed files: <code>{index.get('file_count')}</code>; chunks: <code>{index.get('chunk_count')}</code>.</p>
<h2>Useful links</h2>
<ul>
  <li><a href="/">Notes overview</a></li>
  <li><a href="/graph">Visual graph</a></li>
  <li><a href="/graph.json">Graph JSON</a></li>
  <li><a href="/tools">Tool schemas</a></li>
  <li><a href="/health">Health JSON</a></li>
</ul>
</body></html>"""


def call_tool(name: str, args: dict[str, Any]) -> Any:
    if name == "brain_search":
        return brain_search(str(args.get("query") or ""), int(args.get("k") or 8), str(args.get("category") or ""), str(args.get("node_type") or ""))
    if name == "brain_get":
        return brain_get(str(args.get("title_or_file") or args.get("name") or ""))
    if name == "brain_neighbors":
        return brain_neighbors(str(args.get("name") or ""), int(args.get("k") or 15))
    if name == "brain_put":
        return brain_put(str(args.get("category") or "Notes"), str(args.get("title") or "Untitled"), str(args.get("text") or ""), str(args.get("source") or "agent"))
    raise ValueError(f"Unknown tool: {name}")


def tool_schemas() -> list[dict[str, Any]]:
    return [
        {
            "name": "brain_search",
            "description": "Hybrid keyword/semantic-lite search over OpenClaw Markdown notes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "k": {"type": "integer", "default": 8},
                    "category": {"type": "string", "default": ""},
                    "node_type": {"type": "string", "default": ""},
                },
                "required": ["query"],
            },
        },
        {
            "name": "brain_get",
            "description": "Return full note chunks by exact title or file path.",
            "inputSchema": {
                "type": "object",
                "properties": {"title_or_file": {"type": "string"}},
                "required": ["title_or_file"],
            },
        },
        {
            "name": "brain_neighbors",
            "description": "Return wiki links out of a note and notes that link back to it.",
            "inputSchema": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "k": {"type": "integer", "default": 15}},
                "required": ["name"],
            },
        },
        {
            "name": "brain_put",
            "description": "Save a durable Markdown note/update to the shared brain.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "category": {"type": "string"},
                    "title": {"type": "string"},
                    "text": {"type": "string"},
                    "source": {"type": "string"},
                },
                "required": ["title", "text"],
            },
        },
    ]


class BrainHandler(http.server.BaseHTTPRequestHandler):
    server_version = "OpenClawSharedBrain/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        log(fmt % args)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in {"", "/"}:
            text_response(self, 200, brain_index_html())
            return
        if parsed.path == "/graph":
            text_response(self, 200, brain_graph_html())
            return
        if parsed.path == "/graph.json":
            json_response(self, 200, brain_graph(load_index()))
            return
        if parsed.path == "/agent-view":
            text_response(self, 200, agent_view_html())
            return
        if parsed.path == "/note":
            query = urllib.parse.parse_qs(parsed.query)
            file_name = (query.get("file") or [""])[0]
            text_response(self, 200, brain_page_shell(f"Note: {file_name}", note_detail_html(file_name)))
            return
        if parsed.path == "/health":
            index = load_index()
            json_response(self, 200, {
                "ok": True,
                "backend": index.get("backend"),
                "files": index.get("file_count"),
                "chunks": index.get("chunk_count"),
                "notes_dir": str(NOTES_DIR),
                "tools": [tool["name"] for tool in tool_schemas()],
            })
            return
        if parsed.path == "/tools":
            json_response(self, 200, {"tools": tool_schemas()})
            return
        json_response(self, 404, {"error": "not_found"})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length") or "0")
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except Exception:
            json_response(self, 400, {"error": "invalid_json"})
            return
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path.startswith("/tools/"):
                name = parsed.path.rsplit("/", 1)[-1]
                json_response(self, 200, {"result": call_tool(name, payload if isinstance(payload, dict) else {})})
                return
            if parsed.path == "/mcp":
                self.handle_mcp(payload)
                return
        except Exception as exc:
            json_response(self, 500, {"error": type(exc).__name__, "message": str(exc)})
            return
        json_response(self, 404, {"error": "not_found"})

    def handle_mcp(self, payload: dict[str, Any]) -> None:
        request_id = payload.get("id")
        method = payload.get("method")
        if method == "initialize":
            result = {
                "protocolVersion": payload.get("params", {}).get("protocolVersion", "2024-11-05"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "openclaw-shared-brain", "version": "0.1"},
            }
        elif method == "tools/list":
            result = {"tools": tool_schemas()}
        elif method == "tools/call":
            params = payload.get("params") or {}
            value = call_tool(str(params.get("name") or ""), params.get("arguments") or {})
            result = {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}]}
        else:
            json_response(self, 200, {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "Method not found"}})
            return
        json_response(self, 200, {"jsonrpc": "2.0", "id": request_id, "result": result})


def serve() -> None:
    write_index()
    server = http.server.ThreadingHTTPServer((HOST, PORT), BrainHandler)
    print(f"OpenClaw Shared Brain listening on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


def main() -> int:
    parser = argparse.ArgumentParser(prog="openclaw-shared-brain")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init").set_defaults(fn=lambda _args: print(json.dumps({"ok": True, "index": write_index().get("chunk_count")}, ensure_ascii=False)))
    sub.add_parser("index").set_defaults(fn=lambda _args: print(json.dumps({"ok": True, "index": write_index().get("chunk_count")}, ensure_ascii=False)))
    search_p = sub.add_parser("search")
    search_p.add_argument("query")
    search_p.add_argument("-k", type=int, default=8)
    search_p.set_defaults(fn=lambda args: print(json.dumps(brain_search(args.query, args.k), ensure_ascii=False, indent=2)))
    get_p = sub.add_parser("get")
    get_p.add_argument("title_or_file")
    get_p.set_defaults(fn=lambda args: print(json.dumps(brain_get(args.title_or_file), ensure_ascii=False, indent=2)))
    neigh_p = sub.add_parser("neighbors")
    neigh_p.add_argument("name")
    neigh_p.add_argument("-k", type=int, default=15)
    neigh_p.set_defaults(fn=lambda args: print(json.dumps(brain_neighbors(args.name, args.k), ensure_ascii=False, indent=2)))
    put_p = sub.add_parser("put")
    put_p.add_argument("category")
    put_p.add_argument("title")
    put_p.add_argument("text")
    put_p.add_argument("--source", default="agent")
    put_p.set_defaults(fn=lambda args: print(json.dumps(brain_put(args.category, args.title, args.text, args.source), ensure_ascii=False, indent=2)))
    ctx_p = sub.add_parser("context")
    ctx_p.add_argument("query")
    ctx_p.add_argument("-k", type=int, default=5)
    ctx_p.set_defaults(fn=lambda args: print(compact_context(args.query, args.k)))
    sub.add_parser("serve").set_defaults(fn=lambda _args: serve())
    args = parser.parse_args()
    args.fn(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
