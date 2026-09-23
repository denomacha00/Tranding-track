"""Optional AI/LLM narration layer.

Honest scope: the LLM does NOT decide trades and cannot guarantee profit. The
deterministic MarketAnalyzer (app/analysis.py) makes the call; this module turns
that structured analysis into a plain-English explanation, and can answer
free-form questions about the current market read. It is entirely optional — if
no API key is configured, `available` is False and callers fall back to the
built-in deterministic summary.

Provider is pluggable via env (OpenAI-compatible chat completions). No key or
network call happens unless the user configures one.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

import httpx

from app.analysis import MarketAnalysis
from app.config import Settings

logger = logging.getLogger(__name__)


class AICommentator:
    """Wraps an OpenAI-compatible chat endpoint to narrate market analysis."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def reload(self, settings: Settings) -> None:
        self._settings = settings

    @property
    def available(self) -> bool:
        return bool(self._settings.ai_api_key)

    def _post(self, messages: list[dict[str, str]], max_tokens: int = 300) -> Optional[str]:
        if not self.available:
            return None
        url = self._settings.ai_base_url.rstrip("/") + "/chat/completions"
        headers = {
            "Authorization": f"Bearer {self._settings.ai_api_key}",
            "Content-Type": "application/json",
        }
        body: dict[str, Any] = {
            "model": self._settings.ai_model,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": max_tokens,
        }
        try:
            with httpx.Client(timeout=self._settings.ai_timeout_seconds) as client:
                resp = client.post(url, headers=headers, json=body)
                resp.raise_for_status()
                data = resp.json()
            return data["choices"][0]["message"]["content"].strip()
        except Exception as exc:
            logger.warning("AI request failed: %s", exc)
            return None

    def narrate(self, analysis: MarketAnalysis) -> str:
        """Return an LLM explanation of the analysis, or the deterministic summary."""
        if not self.available:
            return analysis.summary
        factors = "\n".join(
            f"- {f.name}: {f.signal} ({f.detail})" for f in analysis.factors
        )
        prompt = (
            "You are a risk-conscious trading analyst. Given the structured signal "
            "breakdown below, explain in 2-4 sentences what the market is doing and "
            "why the verdict makes sense. Emphasise capital preservation and never "
            "promise profit or certainty.\n\n"
            f"Symbol: {analysis.symbol}\nPrice: {analysis.price}\n"
            f"Verdict: {analysis.verdict} (confidence {analysis.confidence:.0%})\n"
            f"Factors:\n{factors}"
        )
        out = self._post(
            [
                {"role": "system", "content": "You are a concise, honest trading analyst."},
                {"role": "user", "content": prompt},
            ]
        )
        return out or analysis.summary

    def ask(self, question: str, analysis: MarketAnalysis | None = None) -> str:
        """Answer a free-form question, optionally grounded in current analysis."""
        if not self.available:
            return (
                "AI commentary is not configured. Set AI_API_KEY (and optionally "
                "AI_BASE_URL / AI_MODEL) to enable natural-language market Q&A."
            )
        context = ""
        if analysis is not None:
            context = "\nCurrent analysis JSON:\n" + json.dumps(analysis.as_dict())
        out = self._post(
            [
                {
                    "role": "system",
                    "content": (
                        "You are a risk-conscious crypto trading analyst for the "
                        "Tranding-track bot. Be concise and never promise profits "
                        "or guaranteed outcomes."
                    ),
                },
                {"role": "user", "content": question + context},
            ]
        )
        return out or "AI request failed; please try again."
