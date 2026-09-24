"""Live market-news fetcher for the AI assistant + News panel.

Honest scope: this pulls REAL headlines from public crypto/markets RSS/Atom
feeds (no API key, no user data sent — plain GETs to public URLs). If a feed is
unreachable or malformed we report it as an error and return whatever real items
we did get; we NEVER fabricate a headline. Results are cached briefly so the UI
and the AI can both read "today's" news without hammering the sources.
"""
from __future__ import annotations

import logging
import time
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree as ET

import httpx

logger = logging.getLogger(__name__)

# Small in-process cache: {feeds_key: (fetched_at, items, errors)}.
_CACHE: dict[str, tuple[float, list[dict], list[str]]] = {}
_UA = "Tranding-track/1.0 (+news reader)"


def _localname(tag: str) -> str:
    """Strip any XML namespace: '{ns}item' -> 'item'."""
    return tag.rsplit("}", 1)[-1].lower()


def _normalize_published(text: str | None) -> str | None:
    """Best-effort ISO-8601 normalisation of a feed date; keep raw if we can't."""
    if not text:
        return None
    text = text.strip()
    # RSS uses RFC-822 ("Mon, 22 Sep 2025 14:30:00 GMT").
    try:
        return parsedate_to_datetime(text).isoformat()
    except Exception:
        pass
    # Atom uses ISO-8601, sometimes with a trailing 'Z'.
    try:
        import datetime as dt

        return dt.datetime.fromisoformat(text.replace("Z", "+00:00")).isoformat()
    except Exception:
        return text  # show it as-is rather than dropping a real date


def _sort_key(published: str | None) -> float:
    if not published:
        return 0.0
    try:
        import datetime as dt

        return dt.datetime.fromisoformat(published.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def _parse_feed(xml_text: str, source: str) -> list[dict]:
    """Parse an RSS or Atom document into a list of {title, link, source, published}."""
    items: list[dict] = []
    root = ET.fromstring(xml_text)
    # RSS: channel/item ; Atom: feed/entry. Search by local name to ignore ns.
    entries = [el for el in root.iter() if _localname(el.tag) in ("item", "entry")]
    for el in entries:
        title = link = published = None
        for child in el:
            name = _localname(child.tag)
            if name == "title" and child.text:
                title = child.text.strip()
            elif name == "link":
                # RSS puts the URL in text; Atom in the href attribute.
                href = child.get("href")
                link = (href or (child.text or "")).strip() or link
            elif name in ("pubdate", "published", "updated") and child.text:
                published = published or child.text.strip()
        if title:
            items.append(
                {
                    "title": title,
                    "link": link,
                    "source": source,
                    "published": _normalize_published(published),
                }
            )
    return items


def _source_name(url: str) -> str:
    try:
        host = httpx.URL(url).host or url
    except Exception:
        return url
    return host.replace("www.", "")


def fetch_market_news(
    feeds: list[str], limit: int = 8, ttl: float = 120.0
) -> tuple[list[dict], list[str]]:
    """Return (items, errors). Items are real, newest-first; errors names dead feeds."""
    if not feeds:
        return [], ["no news feeds configured"]
    key = "|".join(feeds)
    now = time.time()
    cached = _CACHE.get(key)
    if cached and now - cached[0] < ttl:
        return cached[1][:limit], cached[2]

    items: list[dict] = []
    errors: list[str] = []
    for url in feeds:
        try:
            with httpx.Client(timeout=8.0, headers={"User-Agent": _UA}) as client:
                resp = client.get(url, follow_redirects=True)
                resp.raise_for_status()
                items.extend(_parse_feed(resp.text, _source_name(url)))
        except Exception as exc:
            logger.warning("news feed failed %s: %s", url, exc)
            errors.append(f"{_source_name(url)} unavailable")

    # De-dupe by title, then sort newest-first by parsed date.
    seen: set[str] = set()
    unique: list[dict] = []
    for it in items:
        t = it["title"]
        if t not in seen:
            seen.add(t)
            unique.append(it)
    unique.sort(key=lambda it: _sort_key(it.get("published")), reverse=True)

    _CACHE[key] = (now, unique, errors)
    return unique[:limit], errors
