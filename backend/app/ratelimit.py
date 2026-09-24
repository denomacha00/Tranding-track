"""A tiny in-process sliding-window rate limiter.

Deliberately dependency-free and in-memory: the app runs as a SINGLE uvicorn
process (in-memory engines + in-process monitor loop preclude multi-worker), so
a per-process limiter is sufficient and correct here. It exists to blunt online
password-guessing and webhook floods, not to be a distributed quota system.

If the deployment is ever scaled to multiple processes, replace the backing
store with Redis (same ``hit`` interface).
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict, deque


class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, key: str, *, limit: int, window_seconds: float) -> bool:
        """Record an attempt for ``key``; return True if it is ALLOWED.

        Allows up to ``limit`` events within any trailing ``window_seconds``.
        The (limit+1)-th event inside the window is rejected (returns False).
        """
        now = time.monotonic()
        cutoff = now - window_seconds
        with self._lock:
            dq = self._hits[key]
            while dq and dq[0] < cutoff:
                dq.popleft()
            if len(dq) >= limit:
                return False
            dq.append(now)
            # Opportunistic cleanup so idle keys don't accumulate forever.
            if len(self._hits) > 4096:
                self._sweep(cutoff)
            return True

    def _sweep(self, cutoff: float) -> None:
        stale = [k for k, dq in self._hits.items() if not dq or dq[-1] < cutoff]
        for k in stale:
            self._hits.pop(k, None)


# Module-level shared instance for the app.
limiter = RateLimiter()


def client_ip(request) -> str:
    """Best-effort client IP, honouring a single proxy hop (Railway/Render).

    Uses the FIRST address in ``X-Forwarded-For`` when present (the original
    client as seen by the edge proxy), else the direct peer. This is only used
    for rate-limit bucketing, never for authorization, so a spoofed header at
    worst lets an attacker rate-limit themselves.
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        first = xff.split(",")[0].strip()
        if first:
            return first
    client = getattr(request, "client", None)
    return client.host if client and client.host else "unknown"
