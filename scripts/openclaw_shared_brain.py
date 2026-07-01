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
