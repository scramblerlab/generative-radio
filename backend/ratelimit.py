"""Minimal in-process sliding-window rate limiter.

slowapi would pull two transitive dependencies for a feature needed in exactly
three places. uvicorn runs single-process here (neither start script passes
--workers), so an in-memory counter is exact rather than approximate.

Keys are caller-supplied — the auth router keys on the real client IP from
netutil.resolve_request_ip, never request.client.host, which is always
127.0.0.1 behind the Cloudflare tunnel.
"""

import logging
import time
from collections import defaultdict, deque

from fastapi import HTTPException

logger = logging.getLogger(__name__)

# Cap the number of tracked keys so a hostile IP range cannot grow this
# unbounded. When exceeded, the least recently touched buckets are dropped.
MAX_BUCKETS = 10_000

_hits: dict[tuple[str, str], deque[float]] = defaultdict(deque)
_last_touch: dict[tuple[str, str], float] = {}


def _evict_if_needed() -> None:
    if len(_hits) <= MAX_BUCKETS:
        return
    victims = sorted(_last_touch, key=_last_touch.get)[: len(_hits) - MAX_BUCKETS + 1000]
    for key in victims:
        _hits.pop(key, None)
        _last_touch.pop(key, None)
    logger.warning(f"[ratelimit] Evicted {len(victims)} stale buckets")


def check(bucket: str, key: str, limit: int, window_s: float) -> None:
    """Record a hit; raise HTTPException(429) if `key` exceeded `limit` in `window_s`."""
    now = time.time()
    entry = (bucket, key)
    hits = _hits[entry]
    _last_touch[entry] = now

    cutoff = now - window_s
    while hits and hits[0] < cutoff:
        hits.popleft()

    if len(hits) >= limit:
        retry_after = max(1, int(hits[0] + window_s - now) + 1)
        logger.warning(f"[ratelimit] {bucket} limit hit for {key!r} — retry in {retry_after}s")
        raise HTTPException(
            status_code=429,
            detail="Too many attempts — please wait and try again",
            headers={"Retry-After": str(retry_after)},
        )

    hits.append(now)
    if not hits:
        _hits.pop(entry, None)
        _last_touch.pop(entry, None)
    _evict_if_needed()


def reset() -> None:
    """Clear all buckets. Test-only."""
    _hits.clear()
    _last_touch.clear()
