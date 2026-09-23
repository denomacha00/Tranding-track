"""Logging configuration: plain text or structured JSON lines.

Structured logs make the bot production-friendly — each record is one JSON object
that a log aggregator (CloudWatch, Loki, ELK) can index. Controlled by the
``log_format`` and ``log_level`` settings.
"""
from __future__ import annotations

import json
import logging


class JsonFormatter(logging.Formatter):
    """Render a log record as a single-line JSON object."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        # Include any structured extras passed via logger.info(..., extra={...}).
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        return json.dumps(payload, default=str)


# Standard LogRecord attributes we don't want duplicated into the JSON body.
_RESERVED = set(
    logging.LogRecord("", 0, "", 0, "", None, None).__dict__.keys()
) | {"message", "asctime"}


def configure_logging(log_format: str = "text", level: str = "INFO") -> None:
    """Configure the root logger. Idempotent — replaces existing handlers."""
    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    for handler in list(root.handlers):
        root.removeHandler(handler)
    handler = logging.StreamHandler()
    if log_format.lower() == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
        )
    root.addHandler(handler)
