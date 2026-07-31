"""
A repeated crash must increment a counter, not author a new row.

POST /api/crashes is unauthenticated by design — a crash has to be reportable
when authentication is exactly what is broken — and it wrote ONE ROW PER CALL
with no aggregation and no cap. The frontend fires it from window.onerror,
onunhandledrejection AND on every 5xx from the shared axios client, so the flood
peaks precisely when the backend is already unhealthy.

The development database reached 3.68 MILLION rows in 27 days (99.2% of the
whole database), of which 3,679,048 were the SAME message, peaking at 8,166 rows
per minute — 27x the app rate limiter, which fails open when Redis is down.
Production holds 76 rows only because it has one user.

The client now de-duplicates and hard-caps per session, but that is the client's
word for it. These tests cover the SERVER's own guarantee.
"""
import uuid

import pytest
from sqlalchemy import delete, func, select

from app.models.crash_event import CrashEvent, CrashSource


def _payload(message: str, endpoint: str = "/crew/prf", error_type: str = "TypeError"):
    return {
        "error_type": error_type,
        "message": message,
        "stacktrace": "at Foo (bundle.js:1:1)",
        "endpoint": endpoint,
        "severity": "error",
        "metadata": {"user_agent": "pytest"},
    }


@pytest.fixture
async def _clean():
    """Remove this test's rows before and after."""
    from tests.conftest import _TestSession

    async def _purge():
        async with _TestSession() as db:
            await db.execute(
                delete(CrashEvent).where(CrashEvent.message.like("PYTEST-CRASH%"))
            )
            await db.commit()

    await _purge()
    yield
    await _purge()


async def _row_count(message: str) -> int:
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        return (await db.execute(
            select(func.count(CrashEvent.id)).where(CrashEvent.message == message)
        )).scalar_one()


async def _occurrences(message: str) -> int:
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        return (await db.execute(
            select(CrashEvent.occurrences).where(CrashEvent.message == message)
        )).scalar_one()


@pytest.mark.asyncio
async def test_a_flood_of_one_fault_creates_exactly_one_row(client, _clean):
    """The regression itself: 50 identical reports, one row."""
    msg = "PYTEST-CRASH send was called before connect"

    for _ in range(50):
        resp = await client.post("/api/crashes", json=_payload(msg))
        assert resp.status_code in (200, 201), resp.text

    rows = await _row_count(msg)
    assert rows == 1, f"50 identical crash reports created {rows} rows, expected 1"

    assert await _occurrences(msg) == 50, "the occurrence counter did not track the flood"


@pytest.mark.asyncio
async def test_distinct_faults_still_get_their_own_rows(client, _clean):
    """Aggregation must not collapse genuinely different problems — otherwise
    the feature hides the second bug behind the first."""
    a = "PYTEST-CRASH alpha failure"
    b = "PYTEST-CRASH beta failure"

    await client.post("/api/crashes", json=_payload(a))
    await client.post("/api/crashes", json=_payload(b))

    assert await _row_count(a) == 1
    assert await _row_count(b) == 1


@pytest.mark.asyncio
async def test_same_message_on_a_different_page_is_a_different_row(client, _clean):
    """endpoint is part of the identity — the same error on two screens is two
    problems for whoever has to fix it."""
    msg = "PYTEST-CRASH shared message"

    await client.post("/api/crashes", json=_payload(msg, endpoint="/crew/prf"))
    await client.post("/api/crashes", json=_payload(msg, endpoint="/admin/cases"))

    assert await _row_count(msg) == 2


@pytest.mark.asyncio
async def test_response_reports_whether_it_deduplicated(client, _clean):
    msg = "PYTEST-CRASH dedup flag"

    first = await client.post("/api/crashes", json=_payload(msg))
    second = await client.post("/api/crashes", json=_payload(msg))

    assert first.json()["deduplicated"] is False
    assert second.json()["deduplicated"] is True
    assert first.json()["crash_id"] == second.json()["crash_id"], (
        "the second report should fold into the first row"
    )


@pytest.mark.asyncio
async def test_a_resolved_crash_does_not_flap_back_open(client, _clean):
    """An operator marking a crash resolved must not have it reopened by a
    stray late report."""
    from tests.conftest import _TestSession

    msg = "PYTEST-CRASH resolved stays resolved"
    await client.post("/api/crashes", json=_payload(msg))

    async with _TestSession() as db:
        row = (await db.execute(
            select(CrashEvent).where(CrashEvent.message == msg)
        )).scalar_one()
        row.resolved = True
        await db.commit()

    await client.post("/api/crashes", json=_payload(msg))

    async with _TestSession() as db:
        row = (await db.execute(
            select(CrashEvent).where(CrashEvent.message == msg)
        )).scalar_one()
        assert row.resolved is True, "a late report reopened a resolved crash"
        assert row.occurrences == 2, "the occurrence count should still advance"
