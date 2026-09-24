"""Tests for the AI provider layer (app/ai.py).

No real network calls: httpx is monkeypatched so we verify the RIGHT endpoint,
headers and body shape are used for each provider style, and that responses are
parsed correctly. These are the parts that actually broke in practice (OpenAI vs
Anthropic-native messages API).
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.ai import AICommentator, _extract_anthropic_text, _looks_anthropic
from app.analysis import Factor, MarketAnalysis


def _settings(**over):
    base = dict(
        ai_api_key="sk-test",
        ai_base_url="https://api.example.com/v1",
        ai_model="gpt-4o-mini",
        ai_api_style="auto",
        ai_timeout_seconds=30.0,
        ai_max_tokens=256,
    )
    base.update(over)
    return SimpleNamespace(**base)


def _analysis():
    return MarketAnalysis(
        symbol="BTC/USDT",
        verdict="buy",
        confidence=0.72,
        score=0.55,
        price=84536.0,
        factors=[Factor("trend", "buy", 0.30, "EMA 9>21>50")],
        summary="deterministic fallback summary",
    )


class _FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _FakeClient:
    """Captures the single POST and returns a canned payload."""

    captured: dict = {}

    def __init__(self, payload, timeout=None):
        self._payload = payload
        _FakeClient.captured = {"timeout": timeout}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, url, headers=None, json=None):
        _FakeClient.captured.update({"url": url, "headers": headers, "body": json})
        return _FakeResp(self._payload)


def _patch_httpx(monkeypatch, payload):
    def factory(timeout=None):
        return _FakeClient(payload, timeout=timeout)

    import app.ai as ai_mod

    monkeypatch.setattr(ai_mod.httpx, "Client", factory)


# ---- style inference -------------------------------------------------

def test_looks_anthropic_by_model():
    assert _looks_anthropic("claude-opus-4-8", "https://api.example.com/v1")
    assert not _looks_anthropic("gpt-4o-mini", "https://api.openai.com/v1")


def test_style_auto_picks_anthropic_for_claude():
    ai = AICommentator(_settings(ai_model="claude-opus-4-8"))
    assert ai._style() == "anthropic"


def test_style_auto_picks_openai_for_gpt():
    ai = AICommentator(_settings(ai_model="gpt-4o-mini"))
    assert ai._style() == "openai"


def test_style_explicit_override_wins():
    ai = AICommentator(_settings(ai_model="claude-opus-4-8", ai_api_style="openai"))
    assert ai._style() == "openai"


# ---- OpenAI path -----------------------------------------------------

def test_openai_hits_chat_completions(monkeypatch):
    _patch_httpx(monkeypatch, {"choices": [{"message": {"content": "hi there"}}]})
    ai = AICommentator(_settings(ai_model="gpt-4o-mini"))
    out = ai.ask("trend?")
    assert out == "hi there"
    cap = _FakeClient.captured
    assert cap["url"].endswith("/chat/completions")
    assert cap["headers"]["Authorization"] == "Bearer sk-test"
    assert cap["body"]["model"] == "gpt-4o-mini"
    assert cap["body"]["messages"][0]["role"] == "system"


# ---- Anthropic path --------------------------------------------------

def test_anthropic_hits_messages_endpoint(monkeypatch):
    _patch_httpx(monkeypatch, {"content": [{"type": "text", "text": "hello world"}]})
    ai = AICommentator(_settings(ai_model="claude-opus-4-8"))
    out = ai.ask("trend?")
    assert out == "hello world"
    cap = _FakeClient.captured
    assert cap["url"].endswith("/messages")
    assert cap["headers"]["x-api-key"] == "sk-test"
    assert cap["headers"]["anthropic-version"] == "2023-06-01"
    assert "Authorization" not in cap["headers"]
    assert cap["body"]["system"]  # system prompt goes in its own field
    assert cap["body"]["max_tokens"] == 256


def test_extract_anthropic_text_joins_blocks():
    data = {"content": [
        {"type": "text", "text": "part one "},
        {"type": "text", "text": "part two"},
        {"type": "tool_use", "id": "x"},
    ]}
    assert _extract_anthropic_text(data) == "part one part two"


def test_extract_anthropic_text_empty_returns_none():
    assert _extract_anthropic_text({"content": []}) is None
    assert _extract_anthropic_text({}) is None


# ---- fallbacks -------------------------------------------------------

def test_no_key_means_unavailable_and_fallback():
    ai = AICommentator(_settings(ai_api_key=""))
    assert ai.available is False
    a = _analysis()
    assert ai.narrate(a) == a.summary
    assert ai.assess(a) == a.summary
    assert "not configured" in ai.ask("x").lower()


def test_narrate_falls_back_when_request_fails(monkeypatch):
    def boom(timeout=None):
        class C:
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
            def post(self, *a, **k):
                raise RuntimeError("network down")
        return C()

    import app.ai as ai_mod
    monkeypatch.setattr(ai_mod.httpx, "Client", boom)
    ai = AICommentator(_settings())
    a = _analysis()
    assert ai.narrate(a) == a.summary


def test_assess_uses_full_token_budget(monkeypatch):
    _patch_httpx(monkeypatch, {"choices": [{"message": {"content": "assessment text"}}]})
    ai = AICommentator(_settings(ai_model="gpt-4o-mini", ai_max_tokens=999))
    out = ai.assess(_analysis())
    assert out == "assessment text"
    assert _FakeClient.captured["body"]["max_tokens"] == 999
