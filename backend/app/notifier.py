"""Optional Telegram notifications for trades and important events.

No-op unless both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are configured, so the
bot runs fine without it. Failures never raise into the trading path — a missed
notification must never break or block an order.
"""
from __future__ import annotations

import logging

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)


class Notifier:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def reload(self, settings: Settings) -> None:
        self._settings = settings

    @property
    def enabled(self) -> bool:
        return bool(
            self._settings.telegram_bot_token and self._settings.telegram_chat_id
        )

    def send(self, text: str) -> bool:
        """Send a message. Returns True on success; never raises."""
        if not self.enabled:
            return False
        url = (
            f"https://api.telegram.org/bot{self._settings.telegram_bot_token}"
            "/sendMessage"
        )
        try:
            with httpx.Client(timeout=10.0) as client:
                resp = client.post(
                    url,
                    json={
                        "chat_id": self._settings.telegram_chat_id,
                        "text": text,
                        "parse_mode": "HTML",
                    },
                )
                resp.raise_for_status()
            return True
        except Exception as exc:
            logger.warning("Telegram notification failed: %s", exc)
            return False
