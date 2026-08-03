"""
The audit trail: append-only in fact, and readable without a database client.

The model called it an "Immutable, append-only POPIA compliance ledger" and
nothing enforced any part of that. The application's own role held UPDATE and
DELETE, so anyone reaching the credentials in .env — on the same VM as nginx —
could erase their own trail from the record of who opened which patient's file.

And it had 31 write sites and ZERO read sites: the log built for POPIA s22
breach scoping could not be queried except with psql on production, which is
exactly the wrong tool for the day it is needed.
"""
from datetime import datetime, timezone

import pytest
from sqlalchemy import text

from app.models.audit_log import AuditLog

pytestmark = pytest.mark.asyncio


async def _seed(action="READ", entity_type="digital_prf", entity_id=None):
    """One audit row, committed, returned by id."""
    import uuid as _uuid
    from tests.conftest import _TestSession

    eid = entity_id or _uuid.uuid4()
    async with _TestSession() as db:
        row = AuditLog(
            action=action, entity_type=entity_type, entity_id=eid,
            details={"actor_name": "PyTest Actor", "actor_type": "back_office"},
            ip_address="203.0.113.10",
        )
        db.add(row)
        await db.commit()
        return row.id, eid


# ════════════════════════════════════════════════════════════════════
# Append-only
# ════════════════════════════════════════════════════════════════════

async def test_the_application_cannot_delete_an_audit_row():
    """The realistic attack: someone with app credentials erasing their trail."""
    from tests.conftest import _TestSession

    row_id, _ = await _seed()
    async with _TestSession() as db:
        with pytest.raises(Exception) as exc:
            await db.execute(text("DELETE FROM audit_logs WHERE id = :i"), {"i": row_id})
            await db.commit()
    assert "append-only" in str(exc.value).lower(), \
        f"an audit row was deletable: {exc.value}"


async def test_the_application_cannot_rewrite_an_audit_row():
    """Editing is as damaging as deleting — a trail that can be rewritten
    proves nothing about what happened."""
    from tests.conftest import _TestSession

    row_id, _ = await _seed()
    async with _TestSession() as db:
        with pytest.raises(Exception) as exc:
            await db.execute(
                text("UPDATE audit_logs SET action = 'HARMLESS' WHERE id = :i"),
                {"i": row_id},
            )
            await db.commit()
    assert "append-only" in str(exc.value).lower()


async def test_inserting_is_unaffected():
    """The guard must not break the thing the table is FOR. 31 write sites
    depend on this."""
    row_id, _ = await _seed(action="TRANSMIT")
    assert row_id is not None


async def test_deliberate_maintenance_is_possible_but_must_be_explicit():
    """The escape hatch, and why it exists.

    Test fixtures clean up their own rows and a lawful erasure order has to be
    executable by someone. The requirement is that it be a visible, deliberate
    act in the same transaction — never something that happens by accident.

    This is a guard rail, NOT tamper-proofing: a party with the database
    credentials can set this flag. Real tamper-evidence needs the app role to
    lack DELETE entirely, or the entries shipped off-box. Neither is done yet,
    and the migration says so rather than overclaiming.
    """
    from tests.conftest import _TestSession

    row_id, _ = await _seed()
    async with _TestSession() as db:
        await db.execute(text("SET LOCAL ems.audit_maintenance = 'on'"))
        await db.execute(text("DELETE FROM audit_logs WHERE id = :i"), {"i": row_id})
        await db.commit()

    async with _TestSession() as db:
        left = (await db.execute(
            text("SELECT count(*) FROM audit_logs WHERE id = :i"), {"i": row_id}
        )).scalar()
    assert left == 0


async def test_the_escape_hatch_does_not_leak_into_the_next_transaction():
    """SET LOCAL is transaction-scoped. If it leaked, one maintenance operation
    would silently disarm the guard for everything after it."""
    from tests.conftest import _TestSession

    row_id, _ = await _seed()
    async with _TestSession() as db:
        await db.execute(text("SET LOCAL ems.audit_maintenance = 'on'"))
        await db.commit()

    async with _TestSession() as db:
        with pytest.raises(Exception) as exc:
            await db.execute(text("DELETE FROM audit_logs WHERE id = :i"), {"i": row_id})
            await db.commit()
    assert "append-only" in str(exc.value).lower(), \
        "the maintenance flag survived its transaction"


# ════════════════════════════════════════════════════════════════════
# Readable
# ════════════════════════════════════════════════════════════════════

async def test_the_trail_requires_admin(client):
    for path in ("/api/audit-logs", "/api/audit-logs/summary"):
        r = await client.get(path)
        assert r.status_code in (401, 403), f"{path} was reachable unauthenticated"


async def test_an_admin_can_search_the_trail(client, auth_headers):
    if not auth_headers:
        pytest.skip("admin login unavailable")
    await _seed(action="TRANSMIT")

    r = await client.get("/api/audit-logs", headers=auth_headers,
                         params={"action": "TRANSMIT", "limit": 5})
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body, list)
    assert all(e["action"] == "TRANSMIT" for e in body), "the action filter is ignored"


async def test_who_accessed_this_record_answers_the_breach_question(client, auth_headers):
    """The question as it actually arrives: not "show me the log" but "who has
    seen THIS patient's file"."""
    if not auth_headers:
        pytest.skip("admin login unavailable")

    _, eid = await _seed(action="READ")
    await _seed(action="TRANSMIT", entity_id=eid)

    r = await client.get(f"/api/audit-logs/patient/{eid}", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["entries"] >= 2
    assert body["actors"], "no actors returned for a record with two accesses"


async def test_reading_the_trail_is_itself_recorded(client, auth_headers):
    """An investigator looking at the log is in the log — which is the property
    that makes the log worth anything."""
    from sqlalchemy import select
    from tests.conftest import _TestSession

    if not auth_headers:
        pytest.skip("admin login unavailable")

    async with _TestSession() as db:
        before = len((await db.execute(
            select(AuditLog).where(AuditLog.entity_type == "audit_log")
        )).scalars().all())

    await client.get("/api/audit-logs", headers=auth_headers, params={"limit": 1})

    async with _TestSession() as db:
        after = len((await db.execute(
            select(AuditLog).where(AuditLog.entity_type == "audit_log")
        )).scalars().all())
    assert after > before, "searching the audit trail left no audit entry"


async def test_the_summary_reports_size_and_says_nothing_auto_deletes(client, auth_headers):
    if not auth_headers:
        pytest.skip("admin login unavailable")
    r = await client.get("/api/audit-logs/summary", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "total_rows_held" in body and "by_action" in body
    assert "No automatic deletion" in body["retention"]


async def test_the_response_size_is_bounded(client, auth_headers):
    """This is the fastest-growing table in the system and the largest single
    disclosure the product can produce."""
    if not auth_headers:
        pytest.skip("admin login unavailable")
    r = await client.get("/api/audit-logs", headers=auth_headers, params={"limit": 100000})
    assert r.status_code == 422, "an unbounded limit was accepted"


async def test_there_is_no_way_to_mutate_the_trail_through_the_api():
    """A read API that grew a delete endpoint would hand back exactly what the
    database trigger took away."""
    from app.api.audit_logs import router

    verbs = {m for r in router.routes for m in getattr(r, "methods", set())}
    assert verbs <= {"GET", "HEAD", "OPTIONS"}, f"the audit router exposes {verbs}"


# ════════════════════════════════════════════════════════════════════
# The guard must exist on a FRESH install, not only after a migration
# ════════════════════════════════════════════════════════════════════

async def test_a_freshly_created_database_gets_the_trigger_too():
    """Found 2026-08-03. The trigger lived ONLY in migration c2f9a48d61be, and a
    migration only ever runs against a database that already exists.

    A fresh client install does not use it: bootstrap_schema.py builds the schema
    from the models with create_all and stamps Alembic at head afterwards. Every
    new instance therefore had `audit_logs` with no trigger — its record of who
    opened which patient's file freely deletable by anyone holding the
    application's own database credentials, which sit on the same VM as nginx.

    The tests above all passed while that was true, because they run against a
    database somebody had already migrated.
    """
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        n = (await db.execute(text(
            "SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_audit_logs_append_only'"
        ))).scalar()
    assert n == 1, (
        "the append-only trigger is missing — on a create_all-built database the "
        "POPIA ledger is mutable"
    )


def test_the_model_and_the_migration_define_the_same_guard():
    """Declared in two places so both install paths are covered; asserted equal
    so they cannot drift into two different guarantees."""
    import importlib.util
    import re
    from pathlib import Path

    from app.models.audit_log import AUDIT_APPEND_ONLY_FN

    mig_path = (Path(__file__).resolve().parents[1]
                / "alembic" / "versions" / "c2f9a48d61be_audit_log_append_only.py")
    src = mig_path.read_text(encoding="utf-8")

    def norm(s: str) -> str:
        return re.sub(r"\s+", " ", s).strip().lower()

    body = norm(AUDIT_APPEND_ONLY_FN)
    # The migration embeds the same function inside an op.execute("""...""").
    assert norm("CREATE OR REPLACE FUNCTION ems_audit_logs_append_only()") in norm(src)
    for fragment in ("ems.audit_maintenance", "insufficient_privilege",
                     "audit_logs is append-only"):
        assert fragment.lower() in body, f"the model's guard lost {fragment!r}"
        assert fragment.lower() in norm(src), f"the migration's guard lost {fragment!r}"
