"""WebSocket connection manager for broadcasting live updates to dashboards.

Each connected socket is tagged with the ``user_id`` it belongs to so that
per-user events (status snapshots carrying a ``user_id``) are delivered ONLY to
that user's sockets. This prevents one user from ever seeing another user's
balances, trades or status. Messages without a ``user_id`` are treated as
global and sent to everyone (used for legacy single-tenant events).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class Broadcaster:
    def __init__(self) -> None:
        self._clients: dict[WebSocket, int | None] = {}
        self._lock = asyncio.Lock()

    async def connect(
        self, ws: WebSocket, user_id: int | None = None, *, accept: bool = True
    ) -> None:
        # ``accept=False`` lets the caller perform the handshake itself (e.g. to
        # negotiate a subprotocol or reject with a custom close code before
        # registering). When True we accept here for the simple case.
        if accept:
            await ws.accept()
        async with self._lock:
            self._clients[ws] = user_id
        logger.info("Dashboard client connected (%d total)", len(self._clients))

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.pop(ws, None)

    async def broadcast(self, message: dict[str, Any]) -> None:
        if not self._clients:
            return
        target = message.get("user_id")
        dead: list[WebSocket] = []
        async with self._lock:
            clients = list(self._clients.items())
        for ws, uid in clients:
            if target is not None and uid != target:
                continue
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.pop(ws, None)
