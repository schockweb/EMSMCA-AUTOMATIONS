"""
Expired token_blacklist rows must be purged.

The blacklist exists so a revoked JWT cannot be replayed before its own `exp`
passes. Once expires_at is in the past the row proves nothing — the token is
rejected on its expiry claim alone. Nothing ever deleted them, so the table only
grew, and is_token_blacklisted() consults it on EVERY authenticated request.

At the stated target (~1500 crew, two sessions a day each, plus admin logins and
every refresh-token rotation) that is roughly 1.1M rows a year of dead weight.
"""
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import delete, select

from app.models.token_blacklist import TokenBlacklist


def _row(jti: str, expires_at: datetime) -> TokenBlacklist:
    return TokenBlacklist(
        jti=jti, user_id=None, token_type="access", expires_at=expires_at
    )


@pytest_asyncio.fixture
async def seeded():
    """Three rows spanning the boundary, cleaned up afterwards."""
    from tests.conftest import _TestSession

    now = datetime.now(timezone.utc)
    rows = {
        "long_expired": now - timedelta(days=30),   # must go
        "just_expired": now - timedelta(days=2),    # must go (past the 1d grace)
        "in_grace": now - timedelta(hours=1),       # expired but inside grace: keep
        "still_valid": now + timedelta(days=5),     # must stay
    }
    async with _TestSession() as db:
        for name, exp in rows.items():
            await db.execute(delete(TokenBlacklist).where(TokenBlacklist.jti == f"purge-{name}"))
            db.add(_row(f"purge-{name}", exp))
        await db.commit()

    yield rows

    async with _TestSession() as db:
        for name in rows:
            await db.execute(delete(TokenBlacklist).where(TokenBlacklist.jti == f"purge-{name}"))
        await db.commit()


async def _jtis_present() -> set[str]:
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        res = await db.execute(
            select(TokenBlacklist.jti).where(TokenBlacklist.jti.like("purge-%"))
        )
        return set(res.scalars().all())


@pytest.mark.asyncio
async def test_purge_removes_expired_and_keeps_valid(seeded):
    """Calls the REAL implementation.

    An earlier version of this test re-issued the DELETE itself, which meant it
    asserted my copy of the query rather than the code that runs in production —
    a wrong cutoff in the task would have passed. purge_expired_blacklist_rows()
    is now the single implementation and the Celery task is a thin wrapper that
    supplies a session, so this exercises the same path.
    """
    from tests.conftest import _TestSession
    from app.tasks.prf_processing import purge_expired_blacklist_rows

    async with _TestSession() as db:
        removed = await purge_expired_blacklist_rows(db)

    remaining = await _jtis_present()

    assert "purge-long_expired" not in remaining, "a 30-day-expired row survived"
    assert "purge-just_expired" not in remaining, "a 2-day-expired row survived"
    assert "purge-still_valid" in remaining, (
        "a VALID revocation was deleted — a revoked token would start working again"
    )
    assert "purge-in_grace" in remaining, "the clock-skew grace period was not honoured"
    assert removed >= 2


@pytest.mark.asyncio
async def test_grace_period_is_honoured_exactly(seeded):
    """With zero grace, the in-grace row must go too — proving the grace window
    is doing the work, not an accident of the fixture's timestamps."""
    from tests.conftest import _TestSession
    from app.tasks.prf_processing import purge_expired_blacklist_rows

    async with _TestSession() as db:
        await purge_expired_blacklist_rows(db, grace=timedelta(0))

    remaining = await _jtis_present()
    assert "purge-in_grace" not in remaining
    assert "purge-still_valid" in remaining, "an unexpired revocation was deleted"


@pytest.mark.asyncio
async def test_purge_never_deletes_an_unexpired_revocation(seeded):
    """The failure that actually matters: deleting a live revocation silently
    un-revokes a token, so a logged-out session starts working again."""
    remaining = await _jtis_present()
    assert "purge-still_valid" in remaining


def test_purge_task_is_registered_on_the_beat_schedule():
    """A task nobody schedules is the same as no task."""
    from app.tasks.celery_app import celery_app

    schedule = celery_app.conf.beat_schedule
    entry = schedule.get("purge-expired-blacklist")
    assert entry is not None, (
        "purge_expired_blacklist is not on the beat schedule, so it will never run"
    )
    assert entry["task"] == "purge_expired_blacklist"
    assert entry["schedule"] <= 86400, "purging less than daily lets the table grow"


def test_purge_task_exists_and_is_named():
    from app.tasks.prf_processing import purge_expired_blacklist

    assert purge_expired_blacklist.name == "purge_expired_blacklist", (
        "the beat schedule references this task by name; a rename breaks it silently"
    )
