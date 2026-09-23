"""Persisted runtime state (KV store) so the bot survives restarts.

What lives here and why:
- ``settings_overrides``: fields changed via PATCH /api/settings. Without this,
  restarting the backend would silently reset trading mode, auto-trade on/off,
  risk params, etc. — dangerous for an unattended bot.
- ``paper_balance``: the simulated wallet. Without this the paper P&L resets on
  every restart and drifts from the trade history in the DB.

Everything is stored as JSON text in the ``kv_store`` table.
"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy.orm import Session

from app.models import KeyValue

SETTINGS_KEY = "settings_overrides"
PAPER_BALANCE_KEY = "paper_balance"


def kv_get(db: Session, key: str, default: Any = None) -> Any:
    row = db.get(KeyValue, key)
    if row is None:
        return default
    try:
        return json.loads(row.value)
    except (ValueError, TypeError):
        return default


def kv_set(db: Session, key: str, value: Any) -> None:
    payload = json.dumps(value)
    row = db.get(KeyValue, key)
    if row is None:
        db.add(KeyValue(key=key, value=payload))
    else:
        row.value = payload
    db.commit()


def load_settings_overrides(db: Session) -> dict[str, Any]:
    data = kv_get(db, SETTINGS_KEY, {})
    return data if isinstance(data, dict) else {}


def save_settings_overrides(db: Session, overrides: dict[str, Any]) -> None:
    kv_set(db, SETTINGS_KEY, overrides)


def load_paper_balance(db: Session, default: float) -> float:
    val = kv_get(db, PAPER_BALANCE_KEY, None)
    try:
        return float(val) if val is not None else default
    except (ValueError, TypeError):
        return default


def save_paper_balance(db: Session, balance: float) -> None:
    kv_set(db, PAPER_BALANCE_KEY, float(balance))
