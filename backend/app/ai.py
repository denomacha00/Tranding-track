"""Optional AI/LLM narration + reasoning layer.

Honest scope: the LLM does NOT decide trades and cannot guarantee profit. The
deterministic MarketAnalyzer (app/analysis.py) makes the call; this module turns
that structured analysis into a plain-English explanation, can answer free-form
questions, and can produce a deeper research-style assessment (risks, scenarios,
position-sizing sanity checks) so the operator loses less to avoidable mistakes.
It is entirely optional — if no API key is configured, `available` is False and
callers fall back to the built-in deterministic summary.

Provider is pluggable. It speaks EITHER:
  * an OpenAI-compatible chat-completions API (POST {base}/chat/completions), or
  * an Anthropic-native messages API (POST {base}/messages with x-api-key +
    anthropic-version headers) — what Claude Code / Claude models use.
The style is chosen from `ai_api_style` ("auto"/"openai"/"anthropic"); "auto"
infers Anthropic when the model looks like Claude or the base URL is
anthropic-flavoured. No key or network call happens unless a key is configured.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

import httpx

from app.analysis import MarketAnalysis
from app.config import Settings

logger = logging.getLogger(__name__)

_SYSTEM_ANALYST = (
    "You are a rigorous, risk-first crypto trading analyst embedded in the "
    "Tranding-track bot. A deterministic engine already produced the numeric "
    "signal; your job is to reason about it like a careful desk analyst so the "
    "operator avoids costly mistakes. Always weigh downside first, flag when a "
    "setup is low-quality or conflicted, and NEVER promise profit or certainty. "
    "Be concrete and concise."
)


def _looks_anthropic(model: str, base_url: str) -> bool:
    m = (model or "").lower()
    b = (base_url or "").lower()
    return "claude" in m or "anthropic" in b


class AICommentator:
    """Wraps an OpenAI- or Anthropic-style chat endpoint to narrate + reason."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def reload(self, settings: Settings) -> None:
        self._settings = settings

    @property
    def available(self) -> bool:
        return bool(self._settings.ai_api_key)

    def _style(self) -> str:
        style = (self._settings.ai_api_style or "auto").lower()
        if style in ("openai", "anthropic"):
            return style
        return (
            "anthropic"
            if _looks_anthropic(self._settings.ai_model, self._settings.ai_base_url)
            else "openai"
        )

    def _post(
        self,
        system: str,
        user: str,
        max_tokens: int | None = None,
    ) -> Optional[str]:
        """Send one system+user turn and return the text reply, or None on failure."""
        if not self.available:
            return None
        max_tokens = max_tokens or self._settings.ai_max_tokens
        base = self._settings.ai_base_url.rstrip("/")
        timeout = self._settings.ai_timeout_seconds
        try:
            with httpx.Client(timeout=timeout) as client:
                if self._style() == "anthropic":
                    resp = client.post(
                        base + "/messages",
                        headers={
                            "x-api-key": self._settings.ai_api_key,
                            "anthropic-version": "2023-06-01",
                            "content-type": "application/json",
                        },
                        json={
                            "model": self._settings.ai_model,
                            "max_tokens": max_tokens,
                            "system": system,
                            "messages": [{"role": "user", "content": user}],
                        },
                    )
                    resp.raise_for_status()
                    data = resp.json()
                    return _extract_anthropic_text(data)
                # OpenAI-compatible chat completions
                resp = client.post(
                    base + "/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self._settings.ai_api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": self._settings.ai_model,
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": user},
                        ],
                        "temperature": 0.2,
                        "max_tokens": max_tokens,
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                return data["choices"][0]["message"]["content"].strip()
        except Exception as exc:
            logger.warning("AI request failed: %s", exc)
            return None

    # ---- public API --------------------------------------------------

    def narrate(self, analysis: MarketAnalysis) -> str:
        """Return an LLM explanation of the analysis, or the deterministic summary."""
        if not self.available:
            return analysis.summary
        prompt = (
            "Explain in 2-4 sentences what the market is doing and why the verdict "
            "makes sense. Emphasise capital preservation.\n\n"
            + self._analysis_block(analysis)
        )
        return self._post(_SYSTEM_ANALYST, prompt, max_tokens=350) or analysis.summary

    def assess(self, analysis: MarketAnalysis) -> str:
        """Deeper research-style assessment: quality, risks, scenarios, sizing.

        This is the "think harder" mode — it does not change the deterministic
        decision, it stress-tests it so the operator loses less to bad entries.
        """
        if not self.available:
            return analysis.summary
        prompt = (
            "Produce a structured risk assessment of this setup. Use short labelled "
            "sections:\n"
            "1. Signal quality (is the confluence real or conflicted?)\n"
            "2. Key risks & what would invalidate the thesis\n"
            "3. Bull vs bear scenario (roughly what price action confirms each)\n"
            "4. Position-sizing / stop sanity check (protect capital first)\n"
            "5. One-line verdict: act or wait, and why.\n"
            "Be honest when the edge is weak. Never promise profit.\n\n"
            + self._analysis_block(analysis)
        )
        return self._post(_SYSTEM_ANALYST, prompt) or analysis.summary

    def ask(self, question: str, analysis: MarketAnalysis | None = None) -> str:
        """Answer a free-form question, optionally grounded in current analysis."""
        if not self.available:
            return (
                "AI commentary is not configured. Set AI_API_KEY (and optionally "
                "AI_BASE_URL / AI_MODEL / AI_API_STYLE) to enable natural-language "
                "market Q&A."
            )
        context = ""
        if analysis is not None:
            context = "\n\nCurrent analysis JSON:\n" + json.dumps(analysis.as_dict())
        return (
            self._post(_SYSTEM_ANALYST, question + context)
            or "AI request failed; please try again."
        )

    @staticmethod
    def _analysis_block(analysis: MarketAnalysis) -> str:
        factors = "\n".join(
            f"- {f.name}: {f.signal} (weight {f.weight}; {f.detail})"
            for f in analysis.factors
        )
        return (
            f"Symbol: {analysis.symbol}\nPrice: {analysis.price}\n"
            f"Verdict: {analysis.verdict} (confidence {analysis.confidence:.0%}, "
            f"score {analysis.score:+.2f})\nFactors:\n{factors}"
        )


def _extract_anthropic_text(data: dict[str, Any]) -> Optional[str]:
    """Pull the text out of an Anthropic messages response."""
    content = data.get("content")
    if isinstance(content, list):
        parts = [
            blk.get("text", "")
            for blk in content
            if isinstance(blk, dict) and blk.get("type") == "text"
        ]
        text = "".join(parts).strip()
        return text or None
    if isinstance(content, str):
        return content.strip() or None
    return None
