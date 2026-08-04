"""Redis circuit-breaker regression tests.

The defect: cache._get_redis() cached a dead client and never re-pinged, so during
a Redis outage every rate-limited request paid the full 2s socket timeout on each
op — a cache outage became an API-wide brownout (measured ~3s/login on the load
stack with Redis stopped). The breaker opens on the first failure, fast-returns
None for a cooldown (so consumers hit their fallbacks without blocking), then
re-probes. These tests pin that behaviour and the RedisError-only trip guard.
"""
import time

import pytest

import app.cache as cache


@pytest.fixture(autouse=True)
def _reset_breaker():
    saved = (cache._redis, cache._redis_down_until)
    cache._redis = None
    cache._redis_down_until = 0.0
    yield
    cache._redis, cache._redis_down_until = saved


@pytest.mark.asyncio
async def test_open_breaker_returns_none_without_connecting(monkeypatch):
    """While the breaker is open, _get_redis must NOT attempt a connection."""
    def _boom():
        raise AssertionError("_get_redis tried to connect while the breaker was open")

    # _get_redis imports get_settings only AFTER the breaker check, so if the
    # check works this is never called.
    monkeypatch.setattr("app.config.get_settings", _boom)
    cache.note_redis_failure()
    assert await cache._get_redis() is None


def test_note_redis_failure_opens_breaker():
    cache._redis = "sentinel-client"
    cache._redis_down_until = 0.0
    cache.note_redis_failure()
    assert cache._redis is None, "the dead client must be dropped"
    assert cache._redis_down_until > time.monotonic(), "breaker must be open"


def test_maybe_trip_ignores_non_redis_errors():
    """A JSON/decode error after a successful GET must not disable Redis."""
    cache._redis_down_until = 0.0
    cache._maybe_trip(ValueError("bad json"))
    assert cache._redis_down_until == 0.0, "a non-Redis error must not trip the breaker"


def test_maybe_trip_fires_on_redis_error():
    from redis.exceptions import RedisError
    cache._redis_down_until = 0.0
    cache._maybe_trip(RedisError("connection refused"))
    assert cache._redis_down_until > time.monotonic(), "a RedisError must trip the breaker"


@pytest.mark.asyncio
async def test_breaker_reprobes_and_closes_after_cooldown(monkeypatch):
    """Once the cooldown passes, _get_redis re-probes and closes on success."""
    class _FakeSettings:
        REDIS_URL = "redis://fake:6379/0"

    class _FakeClient:
        async def ping(self):
            return True

    monkeypatch.setattr("app.config.get_settings", lambda: _FakeSettings())
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "from_url", lambda *a, **k: _FakeClient())

    cache._redis = None
    cache._redis_down_until = time.monotonic() - 1.0  # cooldown already elapsed

    client = await cache._get_redis()
    assert client is not None, "should reconnect after the cooldown"
    assert cache._redis_down_until == 0.0, "breaker should be closed after a good probe"


@pytest.mark.asyncio
async def test_failed_reprobe_reopens_breaker(monkeypatch):
    """If the re-probe fails, the breaker re-opens rather than caching a dead client."""
    class _FakeSettings:
        REDIS_URL = "redis://fake:6379/0"

    def _raise(*a, **k):
        raise ConnectionError("still down")

    monkeypatch.setattr("app.config.get_settings", lambda: _FakeSettings())
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "from_url", _raise)

    cache._redis = None
    cache._redis_down_until = time.monotonic() - 1.0

    assert await cache._get_redis() is None
    assert cache._redis is None
    assert cache._redis_down_until > time.monotonic(), "a failed probe must re-open the breaker"
