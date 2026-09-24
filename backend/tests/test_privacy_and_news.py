"""Privacy redaction + news-parsing unit tests (no network, no credentials)."""
from __future__ import annotations

import json

from app.main import _redact_raw
from app.news import _parse_feed, fetch_market_news


def test_redact_masks_secret_fields():
    raw = json.dumps({"secret": "hunter2", "action": "buy", "symbol": "BTC/USDT"})
    out = json.loads(_redact_raw(raw))
    assert out["secret"] == "***redacted***"
    assert out["action"] == "buy"
    assert out["symbol"] == "BTC/USDT"


def test_redact_normalizes_key_variants():
    raw = json.dumps({"API_Key": "k", "webhookSecret": "w", "note": "ok"})
    out = json.loads(_redact_raw(raw))
    assert out["API_Key"] == "***redacted***"
    assert out["webhookSecret"] == "***redacted***"
    assert out["note"] == "ok"  # non-sensitive field preserved


def test_redact_non_json_drops_body():
    # A non-JSON body might hide a secret we can't locate -> never store it raw.
    out = _redact_raw("secret=hunter2&action=buy")
    assert "hunter2" not in out
    assert "redacted" in out.lower()


def test_parse_rss_extracts_real_items():
    rss = """<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>Feed</title>
      <item><title>BTC rallies</title><link>https://x/1</link>
        <pubDate>Mon, 22 Sep 2025 14:30:00 GMT</pubDate></item>
      <item><title>ETH update</title><link>https://x/2</link></item>
    </channel></rss>"""
    items = _parse_feed(rss, "x")
    titles = [i["title"] for i in items]
    assert "BTC rallies" in titles and "ETH update" in titles
    first = next(i for i in items if i["title"] == "BTC rallies")
    assert first["link"] == "https://x/1"
    assert first["published"]  # normalised, not empty


def test_parse_atom_uses_href_link():
    atom = """<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>Markets move</title>
        <link href="https://y/1"/><updated>2025-09-22T14:30:00Z</updated></entry>
    </feed>"""
    items = _parse_feed(atom, "y")
    assert items[0]["title"] == "Markets move"
    assert items[0]["link"] == "https://y/1"


def test_fetch_news_no_feeds_reports_error_not_fake():
    items, errors = fetch_market_news([], limit=5)
    assert items == []
    assert errors  # honest: says why it's empty, never invents headlines
