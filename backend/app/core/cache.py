"""
Simple in-memory TTL cache for FastAPI.
Eliminates repeated round-trips to Supabase in Ireland for read-heavy data.
No external dependencies — uses Python's built-in time + asyncio.

Usage:
    from app.core.cache import cache

    @cache.ttl(seconds=60)
    async def get_all_crew(db: AsyncSession):
        ...

    # Invalidate when data changes:
    cache.invalidate("get_all_crew")
"""
import asyncio
import time
import hashlib
import json
import logging
from functools import wraps
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)


class TTLCache:
    """Thread-safe in-memory cache with time-to-live expiry."""

    def __init__(self):
        self._store: dict[str, tuple[Any, float]] = {}  # key → (value, expires_at)
        self._lock = asyncio.Lock()

    def _is_expired(self, key: str) -> bool:
        if key not in self._store:
            return True
        _, expires_at = self._store[key]
        return time.monotonic() > expires_at

    async def get(self, key: str) -> Optional[Any]:
        async with self._lock:
            if self._is_expired(key):
                self._store.pop(key, None)
                return None
            value, _ = self._store[key]
            return value

    async def set(self, key: str, value: Any, ttl: int = 60) -> None:
        async with self._lock:
            self._store[key] = (value, time.monotonic() + ttl)

    async def delete(self, key: str) -> None:
        async with self._lock:
            self._store.pop(key, None)

    def invalidate(self, prefix: str) -> None:
        """Synchronously remove all keys that start with prefix."""
        keys_to_remove = [k for k in self._store if k.startswith(prefix)]
        for k in keys_to_remove:
            self._store.pop(k, None)
        if keys_to_remove:
            logger.debug(f"Cache invalidated {len(keys_to_remove)} keys matching '{prefix}*'")

    def invalidate_all(self) -> None:
        self._store.clear()
        logger.debug("Cache cleared entirely")

    def ttl(self, seconds: int = 60, key_prefix: str = ""):
        """
        Decorator — caches the return value of an async function.

        The cache key is derived from the function name + non-db arguments,
        so different query parameters get different cache entries.

        DB session arguments (AsyncSession) are intentionally excluded from
        the cache key and not passed to the cached lookup.
        """
        def decorator(fn: Callable):
            @wraps(fn)
            async def wrapper(*args, **kwargs):
                # Build a stable cache key from function name + serialisable args
                from sqlalchemy.ext.asyncio import AsyncSession
                safe_args = [
                    a for a in args
                    if not isinstance(a, AsyncSession)
                ]
                safe_kwargs = {
                    k: v for k, v in kwargs.items()
                    if not isinstance(v, AsyncSession)
                }
                try:
                    raw = json.dumps({"a": safe_args, "k": safe_kwargs}, default=str, sort_keys=True)
                except Exception:
                    raw = str(safe_args) + str(safe_kwargs)

                prefix = key_prefix or fn.__name__
                cache_key = f"{prefix}:{hashlib.md5(raw.encode()).hexdigest()}"

                cached = await self.get(cache_key)
                if cached is not None:
                    logger.debug(f"Cache HIT  → {cache_key}")
                    return cached

                logger.debug(f"Cache MISS → {cache_key}")
                result = await fn(*args, **kwargs)
                if result is not None:
                    await self.set(cache_key, result, ttl=seconds)
                return result

            # Attach invalidation helper directly to the function
            wrapper.invalidate = lambda: self.invalidate(key_prefix or fn.__name__)
            return wrapper

        return decorator


# Singleton — import and use anywhere in the app
cache = TTLCache()
