"""
Redis cache layer for the EMS Claims Portal.

Why cache?
----------
Without Redis, every admin page load hits PostgreSQL directly.
At 150 admins viewing PRF lists simultaneously, that's 150 concurrent
DB queries — each joining PRFs, cases, claims, crew, and providers.

With Redis:
  - PRF list pages:      cached 60s  → DB load drops ~90% during peak
  - Submitted PRF data:  cached 1hr  → one DB read per hour per PRF
  - Provider config:     cached 1hr  → read once per deployment
  - Crew rosters:        cached 5min → refreshes per shift

Cache invalidation strategy
---------------------------
- PRF draft:     invalidated on every PATCH save (crew changes data often)
- PRF submitted: invalidated on status change only (very rare after submit)
- Provider:      invalidated on provider settings change
- Crew:          TTL-based (5 min acceptable staleness for rosters)

Usage
-----
    from app.cache import get_cache, set_cache, invalidate_prf

    # Read
    data = await get_cache(f"prf:{prf_id}")
    if data is None:
        data = await db.fetch_prf(prf_id)
        await set_cache(f"prf:{prf_id}", data, ttl=60)

    # Write-through invalidation
    await invalidate_prf(prf_id)
"""
from __future__ import annotations
import json
import logging
from typing import Any, Optional

logger = logging.getLogger("ems.cache")

# ── Redis client (module-level singleton) ──────────────────────────────────
# Lazily initialised on first use so import doesn't fail if Redis is down.
_redis: Any = None


async def _get_redis():
    """Return the shared async Redis client, creating it on first call."""
    global _redis
    if _redis is not None:
        return _redis

    from app.config import get_settings
    settings = get_settings()

    if not settings.REDIS_URL:
        return None  # Caching disabled

    try:
        import redis.asyncio as aioredis
        _redis = aioredis.from_url(
            settings.REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=2,
            socket_timeout=2,
        )
        # Ping to verify connection on startup
        await _redis.ping()
        logger.info("Redis cache connected: %s", settings.REDIS_URL)
    except Exception as exc:
        logger.warning("Redis unavailable — caching disabled: %s", exc)
        _redis = None

    return _redis


async def get_cache(key: str) -> Optional[dict]:
    """Fetch a cached JSON value by key. Returns None on miss or error."""
    try:
        r = await _get_redis()
        if r is None:
            return None
        raw = await r.get(key)
        if raw is None:
            return None
        return json.loads(raw)
    except Exception as exc:
        logger.debug("Cache GET error for key=%s: %s", key, exc)
        return None


async def set_cache(key: str, value: dict, ttl: int = 60) -> None:
    """Store a JSON value in the cache with a TTL (seconds). Fails silently."""
    try:
        r = await _get_redis()
        if r is None:
            return
        await r.set(key, json.dumps(value, default=str), ex=ttl)
    except Exception as exc:
        logger.debug("Cache SET error for key=%s: %s", key, exc)


async def delete_cache(key: str) -> None:
    """Delete a single cache key. Fails silently."""
    try:
        r = await _get_redis()
        if r is None:
            return
        await r.delete(key)
    except Exception as exc:
        logger.debug("Cache DELETE error for key=%s: %s", key, exc)


async def delete_cache_pattern(pattern: str) -> int:
    """Delete all keys matching a pattern (e.g. 'prf:*'). Returns count deleted."""
    try:
        r = await _get_redis()
        if r is None:
            return 0
        keys = await r.keys(pattern)
        if keys:
            return await r.delete(*keys)
        return 0
    except Exception as exc:
        logger.debug("Cache DELETE pattern error for pattern=%s: %s", pattern, exc)
        return 0


# ── Typed invalidation helpers ────────────────────────────────────────────


async def invalidate_prf(prf_id: str) -> None:
    """Invalidate all cache entries for a specific PRF (called on every PATCH)."""
    await delete_cache(f"prf:detail:{prf_id}")
    # Also bust any PRF-list caches (they include summary rows for this PRF).
    # Use a broad pattern — list caches are cheap to rebuild.
    await delete_cache_pattern("prf:list:*")


async def invalidate_provider(provider_id: str) -> None:
    """Invalidate cached provider config (called on provider settings save)."""
    await delete_cache(f"provider:{provider_id}")
    await delete_cache_pattern(f"prf:list:{provider_id}:*")


async def cache_health() -> dict:
    """Return Redis connection status for the health-check endpoint."""
    try:
        r = await _get_redis()
        if r is None:
            return {"redis": "disabled"}
        await r.ping()
        info = await r.info("memory")
        return {
            "redis": "connected",
            "used_memory_human": info.get("used_memory_human", "unknown"),
        }
    except Exception as exc:
        return {"redis": "error", "detail": str(exc)}
