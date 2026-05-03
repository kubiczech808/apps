from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path

from agent_m.config import config


def generate_feed(articles: list[dict], output_path: Path | None = None) -> str:
    rss = ET.Element("rss", version="2.0", attrib={
        "xmlns:atom": "http://www.w3.org/2005/Atom",
        "xmlns:content": "http://purl.org/rss/1.0/modules/content/",
    })
    channel = ET.SubElement(rss, "channel")

    ET.SubElement(channel, "title").text = f"{config.site_name} — Bitcoin DCA Blog"
    ET.SubElement(channel, "link").text = config.site_url
    ET.SubElement(channel, "description").text = (
        "Expert articles about Bitcoin Dollar-Cost Averaging (DCA) — "
        "strategies, analysis, and practical guides."
    )
    ET.SubElement(channel, "language").text = "en"
    ET.SubElement(channel, "lastBuildDate").text = format_datetime(
        datetime.now(timezone.utc)
    )

    for article in articles:
        item = ET.SubElement(channel, "item")
        ET.SubElement(item, "title").text = article["title"]
        slug = article.get("slug", "article")
        article_url = f"{config.site_url}/blog/{slug}"
        ET.SubElement(item, "link").text = article_url
        ET.SubElement(item, "guid", isPermaLink="false").text = slug
        ET.SubElement(item, "pubDate").text = format_datetime(
            datetime.fromisoformat(article["published_at"])
        )

        tags = article.get("tags", [])
        for tag in tags:
            ET.SubElement(item, "category").text = tag

        body_html = _markdown_to_basic_html(article.get("body", ""))
        content_encoded = ET.SubElement(item, "content:encoded")
        content_encoded.text = body_html

        description = article.get("body", "")[:300]
        if len(article.get("body", "")) > 300:
            description += "..."
        ET.SubElement(item, "description").text = description

    ET.indent(rss, space="  ")
    xml_str = '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(
        rss, encoding="unicode"
    )

    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(xml_str, encoding="utf-8")

    return xml_str


def _markdown_to_basic_html(md: str) -> str:
    import re

    lines = md.split("\n")
    html_lines = []
    in_list = False

    for line in lines:
        stripped = line.strip()

        if not stripped:
            if in_list:
                html_lines.append("</ul>")
                in_list = False
            html_lines.append("")
            continue

        if stripped.startswith("### "):
            html_lines.append(f"<h3>{stripped[4:]}</h3>")
        elif stripped.startswith("## "):
            html_lines.append(f"<h2>{stripped[3:]}</h2>")
        elif stripped.startswith("# "):
            html_lines.append(f"<h1>{stripped[2:]}</h1>")
        elif stripped.startswith("- ") or stripped.startswith("* "):
            if not in_list:
                html_lines.append("<ul>")
                in_list = True
            html_lines.append(f"<li>{stripped[2:]}</li>")
        elif stripped.startswith("---"):
            html_lines.append("<hr/>")
        elif stripped.startswith("*") and stripped.endswith("*"):
            html_lines.append(f"<p><em>{stripped.strip('*')}</em></p>")
        else:
            text = stripped
            text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', text)
            text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
            text = re.sub(r'\*([^*]+)\*', r'<em>\1</em>', text)
            html_lines.append(f"<p>{text}</p>")

    if in_list:
        html_lines.append("</ul>")

    return "\n".join(html_lines)
