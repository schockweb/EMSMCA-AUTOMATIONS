"""
Idempotency keys must belong to somebody.

The `Idempotency-Key` header was the primary key of a GLOBAL table. Three
consequences, all tested here:

  * one tenant's cached medical-scheme response was served to another;
  * an IN_PROGRESS row left behind by a killed worker blocked that claim
    forever, because nothing aged it out;
  * nothing ever deleted from the table, so scheme response bodies — which
    contain patient data — accumulated without bound.
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import delete, select

from app.models.idempotency import IdempotencyKey
from app.utils.idempotency import (
    STALE_LOCK_MINUTES, _scope, _storage_key, process_idempotent_request,
)

pytestmark = pytest.mark.asyncio


def _request(path="/gateway/", key="shared-key-1"):
    return SimpleNamespace(
        headers={"Idempotency-Key": key},
        url=SimpleNamespace(path=path),
        client=SimpleNamespace(host="203.0.113.5"),
        body=_empty_body,
    )


async def _empty_body():
    return b""


# ════════════════════════════════════════════════════════════════════
# Scoping
# ════════════════════════════════════════════════════════════════════

def test_the_same_header_from_two_actors_is_two_different_keys():
    """The cross-tenant replay, at its root.

    Both admins send `Idempotency-Key: 1`. Under the old scheme that was one
    row, and the second caller was handed the first's cached scheme response.
    """
    a = _storage_key("actor:aaaa", "/gateway/", "1")
    b = _storage_key("actor:bbbb", "/gateway/", "1")
    assert a != b, "two actors sharing a header still collide"


def test_the_same_actor_and_key_on_different_routes_do_not_collide():
    assert _storage_key("actor:a", "/gateway/", "1") != \
           _storage_key("actor:a", "/api/edi/submit", "1")


def test_the_same_actor_key_and_route_is_stable():
    """Idempotency depends on this: the same request must reach the same row."""
    assert _storage_key("actor:a", "/gateway/", "1") == \
           _storage_key("actor:a", "/gateway/", "1")


def test_scope_prefers_the_authenticated_actor_over_the_address():
    user = SimpleNamespace(id="11111111-1111-1111-1111-111111111111", email="a@b.c")
    assert _scope(_request(), user).startswith("actor:")


def test_scope_falls_back_to_the_client_address_when_unauthenticated():
    s = _scope(_request(), None)
    assert s.startswith("ip:") or s == "anon"
    assert s != ""


def test_the_stored_key_does_not_contain_the_callers_string():
    """It is hashed, so a caller-chosen value never reaches a log line or an
    error message verbatim."""
    key = _storage_key("actor:a", "/gateway/", "<script>alert(1)</script>")
    assert "script" not in key
    assert len(key) == 64


# ════════════════════════════════════════════════════════════════════
# End to end against the database
# ════════════════════════════════════════════════════════════════════

async def _clear():
    from tests.conftest import _TestSession
    async with _TestSession() as db:
        await db.execute(delete(IdempotencyKey))
        await db.commit()


async def test_one_actor_does_not_receive_another_actors_cached_response():
    """The whole point, exercised through the real code path."""
    from tests.conftest import _TestSession
    await _clear()

    alice = SimpleNamespace(id="aaaaaaaa-0000-0000-0000-000000000001", email="alice@x.z")
    bob = SimpleNamespace(id="bbbbbbbb-0000-0000-0000-000000000002", email="bob@x.z")

    async def alice_result():
        return {"auth_number": "ALICE-SECRET-AUTH", "member": "Alice"}

    async def bob_result():
        return {"auth_number": "BOB-OWN-AUTH", "member": "Bob"}

    async with _TestSession() as db:
        first = await process_idempotent_request(_request(), db, alice_result, actor=alice)
        assert first["auth_number"] == "ALICE-SECRET-AUTH"

        # Bob sends the SAME header value to the SAME route.
        second = await process_idempotent_request(_request(), db, bob_result, actor=bob)

    assert second["auth_number"] == "BOB-OWN-AUTH", (
        "Bob was served Alice's cached medical-scheme response — the callback "
        "never ran and no ownership check stood in the way"
    )
    await _clear()


async def test_the_same_actor_replaying_gets_the_cached_response():
    """Scoping must not break idempotency itself: a genuine retry by the SAME
    actor must still collapse onto one execution."""
    from tests.conftest import _TestSession
    await _clear()

    alice = SimpleNamespace(id="aaaaaaaa-0000-0000-0000-000000000001", email="alice@x.z")
    calls = []

    async def once():
        calls.append(1)
        return {"auth_number": "ONLY-ONCE"}

    async with _TestSession() as db:
        await process_idempotent_request(_request(), db, once, actor=alice)
        again = await process_idempotent_request(_request(), db, once, actor=alice)

    assert len(calls) == 1, "the protected operation ran twice for one key"
    body = again.body.decode() if hasattr(again, "body") else str(again)
    assert "ONLY-ONCE" in body
    await _clear()


async def test_a_lock_abandoned_by_a_killed_worker_is_reclaimed():
    """Previously permanent: nothing aged an IN_PROGRESS row out, so a claim
    whose worker was SIGKILLed could never be submitted again."""
    from tests.conftest import _TestSession
    await _clear()

    alice = SimpleNamespace(id="aaaaaaaa-0000-0000-0000-000000000001", email="alice@x.z")
    key = _storage_key(_scope(_request(), alice), "/gateway/", "shared-key-1")

    async with _TestSession() as db:
        db.add(IdempotencyKey(
            key=key, status="IN_PROGRESS",
            created_at=datetime.now(timezone.utc) - timedelta(minutes=STALE_LOCK_MINUTES + 5),
        ))
        await db.commit()

    async def ran():
        return {"ok": True}

    async with _TestSession() as db:
        out = await process_idempotent_request(_request(), db, ran, actor=alice)
    assert out == {"ok": True}, "an abandoned lock still blocks the claim forever"
    await _clear()


async def test_a_lock_that_is_still_fresh_is_honoured():
    """The dangerous failure mode of the test above is reclaiming too eagerly —
    which submits a duplicate claim to a medical scheme."""
    from fastapi import HTTPException
    from tests.conftest import _TestSession
    await _clear()

    alice = SimpleNamespace(id="aaaaaaaa-0000-0000-0000-000000000001", email="alice@x.z")
    key = _storage_key(_scope(_request(), alice), "/gateway/", "shared-key-1")

    async with _TestSession() as db:
        db.add(IdempotencyKey(
            key=key, status="IN_PROGRESS",
            created_at=datetime.now(timezone.utc) - timedelta(minutes=1),
        ))
        await db.commit()

    async def must_not_run():
        raise AssertionError("a fresh in-progress lock was ignored")

    async with _TestSession() as db:
        with pytest.raises(HTTPException) as exc:
            await process_idempotent_request(_request(), db, must_not_run, actor=alice)
    assert exc.value.status_code == 409
    await _clear()


async def test_the_purge_task_is_registered_and_scheduled():
    """Nothing ever deleted from this table. A purge that exists but is not
    scheduled — or scheduled but not registered — is the shape that already
    shipped once with report_retention_status."""
    import app.tasks.retention  # noqa: F401  — registers
    from app.tasks.celery_app import celery_app

    assert "purge_expired_idempotency_keys" in celery_app.tasks, \
        "the purge task is not registered with the worker"
    scheduled = {e["task"] for e in celery_app.conf.beat_schedule.values()}
    assert "purge_expired_idempotency_keys" in scheduled, \
        "the purge task is not on the beat schedule"
