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
import time
from typing import Any, Optional

logger = logging.getLogger("ems.cache")

# ── Redis client (module-level singleton) + circuit breaker ─────────────────
# Lazily initialised on first use so import doesn't fail if Redis is down.
#
# THE BROWNOUT THIS BREAKER FIXES
# -------------------------------
# _get_redis() used to cache the client and NEVER re-ping. When Redis went down
# the cached client was handed back on every call, and each operation then blocked
# for the full socket_timeout (2s) before raising — so during a Redis outage every
# rate-limited request paid 2s × (number of Redis ops), turning a cache outage into
# an API-wide brownout (measured: ~3s per login with Redis stopped).
#
# The breaker: the first consumer whose op fails calls note_redis_failure(), which
# drops the client and opens the breaker for a short cooldown. While open,
# _get_redis() returns None IMMEDIATELY — so the rate limiter passes through
# (its deliberate fail-open), login_throttle uses its in-memory fallback, and the
# caches skip, all without blocking. After the cooldown one call re-probes; on
# success the breaker closes. Fail-open policy is unchanged — only the 2s stall is.
_redis: Any = None
_redis_down_until: float = 0.0
_REDIS_BREAKER_COOLDOWN = 10.0  # seconds the breaker stays open before re-probing


def note_redis_failure() -> None:
    """Trip the breaker after a live Redis operation failed on a hot path.

    Called from the Redis except-handlers in this module, the rate-limit
    middleware and login_throttle. Idempotent and cheap.
    """
    global _redis, _redis_down_until
    _redis = None
    _redis_down_until = time.monotonic() + _REDIS_BREAKER_COOLDOWN


def _maybe_trip(exc: Exception) -> None:
    """Trip the breaker only for genuine Redis connectivity errors.

    Handlers in this module wrap Redis ops AND (de)serialisation, so a JSON error
    after a successful GET must not disable Redis — only ConnectionError/TimeoutError
    and their kin (all RedisError subclasses) should.
    """
    try:
        from redis.exceptions import RedisError
    except Exception:
        RedisError = ()  # type: ignore[assignment]
    if isinstance(exc, RedisError):
        note_redis_failure()


async def _get_redis():
    """Return the shared async Redis client, or None when the breaker is open."""
    global _redis, _redis_down_until

    # Breaker open — a recent op failed; don't pay the socket timeout again yet.
    if _redis_down_until and time.monotonic() < _redis_down_until:
        return None

    if _redis is not None:
        return _redis

    from app.config import get_settings
    settings = get_settings()

    if not settings.REDIS_URL:
        return None  # Caching disabled

    try:
        import redis.asyncio as aioredis
        client = aioredis.from_url(
            settings.REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=2,
            socket_timeout=2,
        )
        # Ping to verify connection before adopting the client.
        await client.ping()
        _redis = client
        _redis_down_until = 0.0  # close the breaker
        logger.info("Redis cache connected: %s", settings.REDIS_URL)
    except Exception as exc:
        logger.warning("Redis unavailable — caching disabled: %s", exc)
        _redis = None
        _redis_down_until = time.monotonic() + _REDIS_BREAKER_COOLDOWN  # open the breaker

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
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="strict")
        if raw.startswith(_SENSITIVE_PREFIX):
            from app.utils.crypto import decrypt_str
            plain = decrypt_str(raw[len(_SENSITIVE_PREFIX):])
            if plain is None:
                # Written under a different key — treat as a miss rather than
                # serving nothing useful or raising into the request.
                return None
            return json.loads(plain)
        return json.loads(raw)
    except Exception as exc:
        _maybe_trip(exc)
        logger.debug("Cache GET error for key=%s: %s", key, exc)
        return None


# Marker on cache values that hold patient data. Kept as a prefix on the stored
# string so a reader can tell encrypted from plain without a second key lookup,
# and so existing plaintext entries written before this change still decode.
_SENSITIVE_PREFIX = "enc:v1:"


async def set_cache(key: str, value: dict, ttl: int = 60, sensitive: bool = False) -> None:
    """Store a JSON value in the cache with a TTL (seconds). Fails silently.

    `sensitive=True` encrypts the payload before it reaches Redis.

    WHY: Redis here runs with `--appendonly yes` on a persistent volume, with no
    password and no TLS. The crew PRF detail route cached the full clinical
    record — including the patient's SA ID number already DECRYPTED by the
    column type — for up to an hour. So the one field the platform encrypts in
    PostgreSQL had a plaintext copy sitting in an AOF file on the same disk, and
    anyone with the volume snapshot, or any code execution inside the Docker
    network, could read it with no credential at all. Encrypting at rest in the
    database while writing the same value in clear to a cache is not encrypting
    at rest.

    The alternative — not caching the record — was rejected because the cache is
    what keeps a crew reopening a PRF off the database on a bad connection.
    """
    try:
        r = await _get_redis()
        if r is None:
            return
        payload = json.dumps(value, default=str)
        if sensitive:
            # encrypt_str RAISES on a bad key rather than returning None, so
            # this must be caught here. Falling through to the outer handler
            # would also skip the write, but only by accident — and a later
            # refactor that made the outer handler re-raise would start writing
            # PHI in clear. Skipping the cache is the safe failure.
            from app.utils.crypto import encrypt_str
            try:
                payload = _SENSITIVE_PREFIX + encrypt_str(payload)
            except Exception as exc:
                logger.warning(
                    "Cache SET skipped for key=%s — cannot encrypt (%s). "
                    "Patient data is never cached in clear.", key, exc,
                )
                return
        await r.set(key, payload, ex=ttl)
    except Exception as exc:
        _maybe_trip(exc)
        logger.debug("Cache SET error for key=%s: %s", key, exc)


async def delete_cache(key: str) -> None:
    """Delete a single cache key. Fails silently."""
    try:
        r = await _get_redis()
        if r is None:
            return
        await r.delete(key)
    except Exception as exc:
        _maybe_trip(exc)
        logger.debug("Cache DELETE error for key=%s: %s", key, exc)


# How many keys to pull per SCAN round-trip, and how many to delete per call.
# Big enough that a large keyspace does not cost thousands of round-trips,
# small enough that one command never occupies Redis for long.
_SCAN_BATCH = 500


async def _unlink_batch(r, keys: list) -> int:
    """Remove a batch of keys, preferring UNLINK.

    UNLINK detaches the keys immediately and frees the memory on a background
    thread; DEL frees inline. Old Redis (<4) has no UNLINK, hence the fallback.
    """
    try:
        return await r.unlink(*keys)
    except Exception:
        return await r.delete(*keys)


async def delete_cache_pattern(pattern: str) -> int:
    """Delete all keys matching a pattern (e.g. 'prf:*'). Returns count deleted.

    SCAN, not KEYS.

    `KEYS` walks the ENTIRE keyspace in a single blocking pass, and Redis is
    single-threaded — so for its whole duration every other client waits,
    including the session lookups on the request path. This function is called
    from `invalidate_prf`, which runs on every PRF PATCH: the crew autosave.
    That is the hottest write in the product (each crew saves on every phase
    change, and a shift change puts many crews there at once), so the one place
    a full-keyspace block is least affordable was doing two of them per save.

    SCAN walks the same keyspace in bounded slices, yielding to other clients
    between them. It can return duplicates and can miss keys created mid-scan;
    both are fine here — this is a cache invalidation, and anything created
    during the scan is by definition newer than the write being invalidated.
    """
    try:
        r = await _get_redis()
        if r is None:
            return 0
        deleted = 0
        batch: list = []
        async for key in r.scan_iter(match=pattern, count=_SCAN_BATCH):
            batch.append(key)
            if len(batch) >= _SCAN_BATCH:
                deleted += await _unlink_batch(r, batch)
                batch = []
        if batch:
            deleted += await _unlink_batch(r, batch)
        return deleted
    except Exception as exc:
        _maybe_trip(exc)
        logger.debug("Cache DELETE pattern error for pattern=%s: %s", pattern, exc)
        return 0


# ── Typed invalidation helpers ────────────────────────────────────────────


async def invalidate_prf(prf_id: str) -> None:
    """Invalidate all cache entries for a specific PRF (called on every PATCH)."""
    # The detail cache is written PER CREW MEMBER — digital_prf.py builds the key
    # as `prf:detail:{prf_id}:crew:{crew.id}` so that two crew on the same call
    # get their own entry. This helper deleted the un-suffixed
    # `prf:detail:{prf_id}`, which is a key nothing ever writes, so the delete
    # always matched zero entries and the detail cache was NEVER invalidated.
    #
    # A submitted PRF is cached for CACHE_TTL_PRF_SUBMITTED_SECONDS (3600), so
    # an edit could keep serving the pre-edit clinical record for a full hour.
    # That is a correctness problem with patient data, not a performance one.
    #
    # Pattern-delete both shapes: the crew-suffixed keys that are actually
    # written, and the bare key in case an older entry is still resident.
    await delete_cache(f"prf:detail:{prf_id}")
    await delete_cache_pattern(f"prf:detail:{prf_id}:*")
    # NOTE: there is deliberately no `prf:list:*` sweep here.
    #
    # There used to be, and nothing in the codebase has ever WRITTEN a
    # `prf:list:` key — grep it. So the sweep could only ever match zero keys,
    # while still paying a full pass over the keyspace on every autosave. It
    # was pure cost, and the broad `*` made it the most expensive call of the
    # three. If a PRF-list cache is introduced later, invalidate it here and
    # scope the pattern to the provider — never a bare `*`.


async def invalidate_provider(provider_id: str) -> None:
    """Invalidate cached provider config (called on provider settings save)."""
    await delete_cache(f"provider:{provider_id}")


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
