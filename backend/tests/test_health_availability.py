"""
/health must not be usable to stall the API.

It is unauthenticated AND explicitly exempt from the rate limiter (the limiter
skips it so a wedged limiter cannot fail a load-balancer probe). Per request it
performed a blocking kombu ensure_connection (up to 3s), a blocking
control.inspect() broadcast (up to 3s) and an httpx call to the RabbitMQ
management API (up to 5s). The two blocking calls sat inside `async def` with
nothing awaiting them, so they parked the uvicorn event loop for every request
in flight — an unauthenticated loop against /health could pin the whole API.
"""
import asyncio
import time

import pytest

import app.main as main_module


@pytest.fixture(autouse=True)
def _clear_health_cache():
    main_module._health_cache.update({"at": 0.0, "payload": None, "status": 200})
    yield
    main_module._health_cache.update({"at": 0.0, "payload": None, "status": 200})


@pytest.mark.asyncio
async def test_health_returns_the_expected_shape(client):
    resp = await client.get("/health")
    assert resp.status_code in (200, 503)
    body = resp.json()
    for key in ("api", "database", "rabbitmq", "celery_workers", "queue", "uptime_seconds"):
        assert key in body, f"/health lost the {key!r} field"


@pytest.mark.asyncio
async def test_health_is_cached(client):
    """A second call inside the window must not repeat the broker round-trips."""
    calls = []
    original = main_module._blocking_broker_checks

    def counting():
        calls.append(1)
        return original()

    main_module._blocking_broker_checks = counting
    try:
        await client.get("/health")
        await client.get("/health")
        await client.get("/health")
    finally:
        main_module._blocking_broker_checks = original

    assert len(calls) == 1, (
        f"the broker was probed {len(calls)} times for 3 rapid /health calls — "
        f"the cache is not working"
    )


@pytest.mark.asyncio
async def test_health_cache_expires(client):
    """Caching must not turn /health into a stale lie — a real outage has to
    surface once the window passes."""
    calls = []
    original = main_module._blocking_broker_checks

    def counting():
        calls.append(1)
        return original()

    main_module._blocking_broker_checks = counting
    try:
        await client.get("/health")
        # Age the cache past the window without actually sleeping for it.
        main_module._health_cache["at"] -= (main_module._HEALTH_CACHE_SECONDS + 1)
        await client.get("/health")
    finally:
        main_module._blocking_broker_checks = original

    assert len(calls) == 2, "an expired cache entry was still served"


@pytest.mark.asyncio
async def test_health_does_not_block_the_event_loop(client):
    """The regression this is really about.

    A deliberately slow broker probe must not stop other coroutines running.

    Ticks are counted ONLY across the probe's own window, recorded from inside
    the stub. Counting them across the whole request does not work: the
    handler's other awaits (the DB query, and the httpx call to the RabbitMQ
    management API, which times out slowly in an isolated environment) let the
    ticker advance plenty even when the broker probe is blocking the loop — so
    that version of this test passed with the fix reverted.
    """
    original = main_module._blocking_broker_checks
    window = {}

    def slow():
        window["start"] = ticks
        time.sleep(1.0)          # stands in for a wedged RabbitMQ
        window["end"] = ticks
        return {"rabbitmq": "healthy", "celery_workers": "healthy (1 nodes)"}

    main_module._blocking_broker_checks = slow
    ticks = 0

    async def ticker():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    task = asyncio.create_task(ticker())
    try:
        await client.get("/health")
    finally:
        task.cancel()
        main_module._blocking_broker_checks = original

    assert "start" in window and "end" in window, "the broker probe never ran"
    advanced = window["end"] - window["start"]

    # ~100 ticks are possible in 1s. Running on the loop yields 0.
    assert advanced > 20, (
        f"the event loop advanced only {advanced} ticks during a 1s broker probe — "
        f"the blocking call is running on the loop, not in a thread"
    )


@pytest.mark.asyncio
async def test_concurrent_health_probes_collapse_to_one_check(client):
    """Single-flight: a burst must not each start its own broker round-trip."""
    calls = []
    original = main_module._blocking_broker_checks

    def slow_counting():
        calls.append(1)
        time.sleep(0.3)
        return {"rabbitmq": "healthy", "celery_workers": "healthy (1 nodes)"}

    main_module._blocking_broker_checks = slow_counting
    try:
        await asyncio.gather(*[client.get("/health") for _ in range(5)])
    finally:
        main_module._blocking_broker_checks = original

    assert len(calls) == 1, (
        f"5 concurrent probes triggered {len(calls)} broker checks — "
        f"the single-flight lock is not working"
    )
