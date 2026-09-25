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

_SYSTEM_ASSISTANT = (
    "You are the in-app assistant for the Tranding-track trading bot, talking to "
    "its operator about THEIR own account. You are also the app's guide: users may "
    "ask how the app works or how to do something (add exchange keys, go live, run "
    "a backtest, connect TradingView, read a signal) — walk them through it using "
    "the APP GUIDE, and never invent features that aren't in it. You are given a "
    "live, NON-secret snapshot of THIS user's own account; ground every answer in "
    "it and be concrete about their real numbers and state. You can explain the "
    "bot, read the current market analysis, reason about strategy/skills, weigh in "
    "on a decision, and factor in recent real news. You are risk-first and honest: "
    "you never promise profit, you flag weak/conflicted setups, and you remember "
    "this is real money. You cannot place orders or change settings yourself — "
    "recommend actions and tell the operator exactly which control to use; they "
    "confirm and execute. Never ask for or repeat secrets/API keys."
)

# What the assistant knows about the product itself, so "how does this work?" and
# "how do I…" questions get accurate, specific answers instead of generic ones.
# Kept factual to the real features; do not describe anything the app can't do.
_APP_GUIDE = (
    "APP GUIDE — how Tranding-track works (answer how-to questions from this; don't "
    "invent features):\n"
    "• Purpose: a multi-user crypto trading bot. Each user has their own isolated "
    "account, settings, trades and (optional) exchange keys — no user sees another's "
    "data.\n"
    "• Access: sign up with email + password, then activate an ACTIVE licence. A "
    "pending user redeems a licence key (Login screen or the in-app banner); admins "
    "mint keys and manage users in the Admin panel.\n"
    "• Trading modes: 'paper' simulates orders with no real money (safe default); "
    "'live' places REAL orders. Change it in Settings → Trading mode; always prove a "
    "strategy in paper/testnet first.\n"
    "• Exchange keys: Settings → 'Your Binance API keys'. Paste TRADE-ONLY keys "
    "(withdrawals OFF); they're encrypted at rest and never shown again. Tick 'Use "
    "Binance testnet' for fake-money testing. Saving immediately runs a live "
    "connection test and reports whether it truly connected.\n"
    "• Connection status: the Settings access-card and its 'Test connection' button "
    "show — live — whether the app can read public data, read the account, and "
    "trade. HTTP 451 means the exchange is geo-blocking the SERVER's region (not a "
    "key problem): the operator must deploy in a supported region, set an "
    "EXCHANGE_HTTP_PROXY, or (US) EXCHANGE_ID=binanceus.\n"
    "• Manual trading (Trades tab / trade panel): buy, sell or close a symbol; "
    "stop-loss / take-profit default from Settings. Open positions and history show "
    "in Trades.\n"
    "• Risk rules (Settings): risk per trade %, daily loss limit %, default "
    "stop-loss / take-profit %, trailing stop %, max open positions, max total "
    "exposure %, min signal confidence. The bot enforces these — advise within them.\n"
    "• Autonomous trading: 'Enable autonomous trading' lets the bot act on its "
    "analyzer for the chosen auto symbols/timeframe. Optional 'AI trade review' lets "
    "the AI VETO a risky entry — it can never invent, size or force a trade.\n"
    "• Tools: Analyze (deterministic buy/sell/hold verdict + factors, with optional "
    "AI narration/assessment), Backtest (test a strategy on history), Train (search "
    "strategy parameters on historical data).\n"
    "• Signals tab: a timeline of every analyzer/webhook signal, whether it was "
    "accepted, and its confidence.\n"
    "• TradingView: each user has a private webhook URL (Settings). Point a "
    "TradingView alert at it with a JSON message to trade from alerts — there is no "
    "TradingView API key; the URL itself is the credential, keep it private.\n"
    "• News: the assistant can attach REAL public market headlines on request; an "
    "empty list means the feeds were unreachable, never fabricated.\n"
    "• The AI assistant (you): built into the app and funded by the operator — users "
    "never enter an AI key. You advise only; you cannot place orders or change "
    "settings.\n"
    "• Privacy & security: keys/secrets are encrypted at rest and isolated per user. "
    "You receive only a NON-secret snapshot of the asking user's OWN account — never "
    "keys, passwords, the webhook token, or any other user's data."
)

# The assistant has "hands": when the user asks to be shown or taken somewhere, it
# can emit a navigation action the app executes (the frontend turns it into a
# button that switches to that screen). This never changes data — it only moves
# the user around the UI — so it's safe to act on without a confirmation step.
_NAV_ACTIONS = (
    "NAVIGATION: if the user asks to be shown or taken to part of the app (e.g. "
    "\"show me my trades\", \"take me to settings\", \"where do I add my keys\", "
    "\"open the assistant\"), answer briefly THEN append on its own final line a tag "
    "of the form [[goto:<dest>]] where <dest> is exactly one of: trades, signals, "
    "assistant, analyze, train, backtest, settings, admin. Use settings for adding "
    "exchange keys, testing the connection, or changing risk/mode. Only ever emit "
    "one tag, only when the user actually wants to go somewhere, and never invent a "
    "destination outside that list. The tag is machine-read and hidden from the "
    "user, so keep your sentence self-contained."
)


def _looks_anthropic(model: str, base_url: str) -> bool:
    m = (model or "").lower()
    b = (base_url or "").lower()
    return "claude" in m or "anthropic" in b


def _key_family(key: str) -> str:
    """Best-effort provider guess from a key's PUBLIC prefix (never the secret).

    Anthropic keys start ``sk-ant-``, OpenAI ``sk-``/``sk-proj-``. Knowing the
    family lets the dashboard flag the classic mismatch — an OpenAI key sent
    Anthropic-style (or vice versa) — which returns 401 even though the key is
    real. Only the well-known prefix scheme is used; no key characters leak.
    """
    k = (key or "").strip()
    if not k:
        return "none"
    if k.startswith("sk-ant-"):
        return "anthropic (sk-ant-…)"
    if k.startswith(("sk-proj-", "sk-")):
        return "openai (sk-…)"
    if k.startswith("gsk_"):
        return "groq (gsk_…)"
    return "unrecognized prefix"


class AICommentator:
    """Wraps an OpenAI- or Anthropic-style chat endpoint to narrate + reason."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        # Human-readable reason the last provider call failed (no secrets). Lets
        # the UI/assistant say WHY the AI didn't answer instead of a vague retry.
        self._last_error: str = ""

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
            self._last_error = "no AI key configured"
            return None
        self._last_error = ""
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
            self._last_error = _describe_ai_error(exc)
            # Log the category, never the key or full payload.
            logger.warning("AI request failed: %s", self._last_error)
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
            + "\n\n"
            + self._risk_block()
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
        reply = self._post(_SYSTEM_ANALYST, question + context)
        if reply is not None:
            return reply
        return f"AI request failed: {self._last_error}."

    def chat(
        self,
        question: str,
        *,
        analysis: "MarketAnalysis | None" = None,
        bot_context: str | None = None,
        news: list[dict] | None = None,
    ) -> str:
        """Assistant answer grounded in the user's OWN bot state + optional news.

        Privacy: the caller assembles ``bot_context`` from non-secret data only
        (never exchange keys/passwords). Headlines are public. Everything is sent
        to the USER'S OWN configured AI provider. If AI isn't configured we say so
        plainly rather than pretending to answer.
        """
        if not self.available:
            return (
                "AI assistant is not configured. Add your AI key in Settings "
                "(AI_API_KEY / AI_BASE_URL / AI_MODEL) to chat with the bot, ask "
                "for a read on the market, or get a second opinion on a decision."
            )
        blocks: list[str] = []
        if bot_context:
            blocks.append("Live bot context (the user's own account):\n" + bot_context)
        if analysis is not None:
            blocks.append(self._analysis_block(analysis))
        blocks.append(self._risk_block())
        if news:
            headlines = "\n".join(
                f"- {n.get('title')} ({n.get('source')})"
                for n in news
                if n.get("title")
            )
            if headlines:
                blocks.append(
                    "Recent REAL market headlines (public feeds; use only if "
                    "relevant, and don't overstate their certainty):\n" + headlines
                )
        prompt = (
            question
            + "\n\n---\n"
            + "\n\n".join(blocks)
            + "\n\n---\nAnswer helpfully and concretely for THIS bot and account. "
            "You may recommend an action (and how to do it here), but you cannot "
            "execute it — the operator stays in control and confirms every order. "
            "Weigh downside first and never promise profit."
        )
        # System prompt = who you are + how the app works + how to navigate it, so
        # the assistant can both explain the product and drive the UI on request.
        system = _SYSTEM_ASSISTANT + "\n\n" + _APP_GUIDE + "\n\n" + _NAV_ACTIONS
        reply = self._post(system, prompt)
        if reply is not None:
            return reply
        return (
            "I couldn't reach the AI provider right now — "
            f"{self._last_error}. Your bot and its data are unaffected; this only "
            "means the chat/LLM couldn't answer. The operator can check the "
            "AI_API_KEY / AI_BASE_URL / AI_MODEL / AI_API_STYLE settings."
        )

    def health(self) -> dict[str, Any]:
        """Live check that the configured AI provider actually answers.

        Makes ONE tiny real request (no fabrication). Returns non-secret status
        the UI can show so "the AI isn't working" becomes a concrete reason
        (bad key, wrong model, unreachable) instead of a mystery. The API key
        itself is never included.
        """
        status: dict[str, Any] = {
            "enabled": self.available,
            "ok": False,
            "model": self._settings.ai_model,
            "base_url": self._settings.ai_base_url,
            "style": self._style(),
            "detail": "",
        }
        if not self.available:
            status["detail"] = (
                "No AI key configured. The operator sets AI_API_KEY (and "
                "optionally AI_BASE_URL / AI_MODEL / AI_API_STYLE) on the server."
            )
            return status
        reply = self._post(_SYSTEM_ASSISTANT, "Reply with exactly: ok", max_tokens=5)
        if reply:
            status["ok"] = True
            status["detail"] = (
                f"AI provider reachable and the key works ({self._style()} style, "
                f"model {self._settings.ai_model})."
            )
        else:
            # Reveal the RESOLVED provider settings (never the key) so a
            # misconfiguration is self-evident. The key FAMILY (from its public
            # prefix) vs the send STYLE is the usual smoking gun: an OpenAI key
            # (sk-…) sent anthropic-style — or a Claude key (sk-ant-…) sent
            # openai-style to api.openai.com — returns 401 with a real key.
            style = self._style()
            family = _key_family(self._settings.ai_api_key)
            hint = ""
            if (family.startswith("anthropic") and style != "anthropic") or (
                family.startswith("openai") and style != "openai"
            ):
                hint = (
                    f" — your key looks like {family} but it's being sent "
                    f"{style}-style; set AI_API_STYLE + AI_BASE_URL to match the key"
                )
            elif family == "unrecognized prefix":
                hint = " — the key's format isn't a known OpenAI/Anthropic prefix"
            status["detail"] = (
                f"{self._last_error or 'AI request failed'} "
                f"[resolved: style={style}, key={family}, "
                f"model={self._settings.ai_model or '(unset)'}, "
                f"base_url={self._settings.ai_base_url or '(unset)'}]{hint}"
            )
        return status

    def confirm_trade(self, analysis: MarketAnalysis) -> tuple[bool, str]:
        """Risk-first AI review of a proposed ENTRY. Returns (proceed, reason).

        The deterministic brain already decided to act; the AI may only VETO
        (block new risk) or approve — it cannot invent a trade or block an exit.
        If the AI is unavailable or its reply can't be parsed we PROCEED with the
        deterministic decision (never fabricate a veto or an approval).
        """
        if not self.available:
            return True, "AI review unavailable; deterministic decision stands"
        prompt = (
            "The deterministic engine wants to OPEN this position. Review it "
            "risk-first and decide whether to APPROVE or VETO the entry. Veto only "
            "when the setup is low-quality, conflicted, or the risk clearly "
            "outweighs the edge. Reply with STRICT JSON and nothing else: "
            '{"decision": "approve" | "veto", "reason": "<one concise sentence>"}\n\n'
            + self._analysis_block(analysis)
            + "\n\n"
            + self._risk_block()
        )
        reply = self._post(_SYSTEM_ANALYST, prompt, max_tokens=200)
        if not reply:
            return True, "AI review failed; deterministic decision stands"
        try:
            data = json.loads(_extract_json(reply))
            decision = str(data.get("decision", "")).strip().lower()
            reason = str(data.get("reason", "")).strip() or "no reason given"
        except Exception:
            return True, "AI review inconclusive; deterministic decision stands"
        if decision == "veto":
            return False, f"AI veto: {reason}"
        return True, f"AI approved: {reason}"

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

    def _risk_block(self) -> str:
        """The bot's own risk rules, so sizing/stop advice is grounded in the
        real numbers this account trades with rather than generic guesses."""
        s = self._settings
        return (
            "Bot risk configuration (these ARE the rules that will execute — "
            "advise within them, do not tell the user to override them):\n"
            f"- Mode: {getattr(s, 'trading_mode', 'paper')}\n"
            f"- Risk per trade: {getattr(s, 'risk_per_trade_pct', 0)}% of equity\n"
            f"- Default stop-loss: {getattr(s, 'default_stop_loss_pct', 0)}%; "
            f"take-profit: {getattr(s, 'default_take_profit_pct', 0)}%; "
            f"trailing stop: {getattr(s, 'trailing_stop_pct', 0)}%\n"
            f"- Max open positions: {getattr(s, 'max_open_positions', 0)}; "
            f"daily loss limit: {getattr(s, 'daily_loss_limit_pct', 0)}% of equity\n"
            f"- Max total exposure: {getattr(s, 'max_total_exposure_pct', 0)}% "
            "(0 = uncapped)"
        )


def _is_edge_block(resp: httpx.Response) -> bool:
    """True when a response looks like a CDN/WAF (e.g. Cloudflare) block or
    challenge page rather than a genuine API reply — i.e. the request never
    reached the provider's API. Detected from the ``server`` header, a
    Cloudflare ray id, or an HTML challenge body ("Attention Required",
    "Just a moment"). Kept defensive: diagnostics must never raise."""
    try:
        if "cloudflare" in resp.headers.get("server", "").lower():
            return True
        if resp.headers.get("cf-ray") or resp.headers.get("cf-mitigated"):
            return True
        if "text/html" in resp.headers.get("content-type", "").lower():
            body = resp.text[:2000].lower()
            markers = ("attention required", "just a moment", "cloudflare",
                       "cf-browser-verification", "enable javascript")
            if any(m in body for m in markers):
                return True
    except Exception:  # noqa: BLE001 — never let error-describing itself fail
        return False
    return False


def _describe_ai_error(exc: Exception) -> str:
    """Turn a provider exception into a short, secret-free reason string.

    Never includes the API key or full request/response body — only the failure
    category, so it is safe to show the user and log.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if _is_edge_block(exc.response):
            return (
                f"the provider's edge/firewall (e.g. Cloudflare) blocked the "
                f"request (HTTP {code}) — this is NOT a key problem; the request "
                "never reached the AI API. The gateway is refusing server-to-server "
                "calls. Use a provider that allows API access from servers, or ask "
                "the gateway operator to allowlist your server."
            )
        if code in (401, 403):
            return (
                f"the AI provider rejected the key (HTTP {code}) — check AI_API_KEY "
                "and that AI_API_STYLE matches the provider"
            )
        if code == 404:
            return (
                "the AI model or endpoint was not found (HTTP 404) — check "
                "AI_MODEL and AI_BASE_URL"
            )
        if code == 429:
            return "the AI provider is rate-limiting (HTTP 429) — wait and retry"
        if 500 <= code < 600:
            return f"the AI provider had a server error (HTTP {code}) — retry shortly"
        return f"the AI provider returned HTTP {code}"
    if isinstance(exc, httpx.TimeoutException):
        return "the AI provider timed out — it may be slow or unreachable"
    if isinstance(exc, httpx.ConnectError):
        return "could not reach the AI provider — check the network or AI_BASE_URL"
    if isinstance(exc, (KeyError, IndexError, ValueError)):
        return "the AI provider returned an unexpected response format"
    return f"AI request error ({type(exc).__name__})"


def _extract_json(text: str) -> str:
    """Return the first {...} JSON-object substring (models sometimes wrap JSON)."""
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1]
    return text


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
