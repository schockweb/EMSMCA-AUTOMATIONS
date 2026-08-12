"""Two things the onboarding session on 2026-08-12 depends on.

1. CREATION IS ATTRIBUTED. Deactivating a client has always written an audit
   row naming the admin who did it; creating one wrote nothing but a log line
   with no actor. With four admin workers onboarding a hundred companies in
   parallel, "who added this client, and when?" had no answer anywhere.

2. THE LOSER OF A CREATE RACE GETS A 400, NOT A 500. create_provider checks
   slug/portal-login/admin-email with SELECTs and then INSERTs. The DB unique
   indexes always held, so a duplicate was never actually created — but the
   loser saw "An internal error occurred. Our team has been notified.", which
   reads as an outage rather than a name clash. The documented failure mode is
   that the worker then invents a different company name and creates a SECOND,
   wrong client, and the company name is one of the two fields no screen can
   ever repair.

The race is reproduced through the real widening cause rather than simulated:
`_verify_new_smtp_credential` performs a live SMTP login BETWEEN the uniqueness
pre-checks and the INSERT, so with a PRF sending account configured the window
is seconds wide. Patching that call to insert the competing row is the same
sequence of database operations that two admin workers produce.
"""
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api import providers as providers_api
from app.models.audit_log import AuditLog
from app.models.service_provider import ServiceProvider
from app.models.user import User

RUN = uuid.uuid4().hex[:8]


def _company(tag: str) -> dict:
    return {
        "name": f"Audit {RUN} {tag}",
        "pr_number": f"PR-{tag}",
        "phone": "011 000 0000",
        "address": "1 Rehearsal Road",
        "portal_login_email": f"portal.{tag}.{RUN}@audit.test",
        "portal_login_password": f"Portal!{tag}9aA",
    }


@pytest.fixture
async def created(client, auth_headers):
    """Create clients through the real API and clean them up afterwards."""
    made: list[str] = []

    async def _create(body: dict):
        res = await client.post("/api/providers", json=body, headers=auth_headers)
        if res.status_code in (200, 201):
            made.append(res.json()["id"])
        return res

    yield _create

    for pid in made:
        await client.delete(f"/api/providers/{pid}", headers=auth_headers)


# ── 1. Attribution ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_creating_a_client_records_who_did_it(client, auth_headers, created):
    from tests.conftest import _TestSession

    res = await created(_company("attrib"))
    assert res.status_code in (200, 201), res.text
    pid = uuid.UUID(res.json()["id"])

    async with _TestSession() as db:
        row = (await db.execute(
            select(AuditLog).where(
                AuditLog.entity_type == "service_provider",
                AuditLog.entity_id == pid,
                AuditLog.action == "PROVIDER_CREATED",
            )
        )).scalar_one_or_none()

        assert row is not None, (
            "creating a client wrote no audit row — with several workers "
            "onboarding in parallel, nobody can be asked about a bad entry"
        )

        # The actor must be the admin who was signed in, not merely non-null.
        actor = (await db.execute(
            select(User).where(User.id == row.user_id)
        )).scalar_one_or_none()
        assert actor is not None, f"audit row names user_id {row.user_id}, who does not exist"
        assert actor.email == "admin@emsclaims.co.za", (
            f"the audit row credits {actor.email}, not the signed-in admin"
        )

        assert row.after_state["slug"] == res.json()["slug"]
        assert row.details["portal_login_configured"] is True

        # This table is the append-only POPIA ledger and is read during support
        # work. It must record THAT a login was configured, never what it was.
        blob = f"{row.details}{row.after_state}{row.before_state}".lower()
        for secret in ("portal!attrib9aA".lower(), "password", "hash"):
            assert secret not in blob, f"the audit row leaks '{secret}': {blob}"


@pytest.mark.asyncio
async def test_the_new_audit_row_does_not_make_a_fresh_client_undeletable(client, auth_headers):
    """A client onboarded by mistake must still be removable.

    `delete_provider` refuses once clinical history exists, counting audit rows
    — so writing an audit row at CREATE time is one edit away from making every
    brand-new client permanently undeletable, and the company name is a field no
    screen can repair. It does not, because that count is scoped to
    `crew_member_id` (the POPIA patient-access trail) while PROVIDER_CREATED
    carries only `user_id` and `entity_id`. Asserted rather than assumed:
    correcting a mistyped company name is the documented recovery.
    """
    res = await client.post("/api/providers", json=_company("deletable"), headers=auth_headers)
    assert res.status_code in (200, 201), res.text
    pid = res.json()["id"]

    gone = await client.delete(f"/api/providers/{pid}", headers=auth_headers)
    assert gone.status_code in (200, 204), (
        f"a client created minutes ago can no longer be deleted: "
        f"{gone.status_code} {gone.text}"
    )
    # 409 is the specific regression this guards against — the "has clinical
    # history" refusal firing on a client that has none.
    assert gone.status_code != 409, "the create-time audit row is being read as clinical history"


@pytest.mark.asyncio
async def test_a_refused_create_leaves_no_audit_row_claiming_success(client, auth_headers):
    """The audit row is added before the commit, so a failed create must not
    leave one behind asserting a client was made."""
    from tests.conftest import _TestSession

    body = _company("ghost")
    body["portal_login_password"] = "short"  # refused by the complexity rule

    res = await client.post("/api/providers", json=body, headers=auth_headers)
    assert 400 <= res.status_code < 500, res.status_code

    async with _TestSession() as db:
        rows = (await db.execute(
            select(AuditLog).where(
                AuditLog.action == "PROVIDER_CREATED",
                AuditLog.after_state["name"].astext == body["name"],
            )
        )).scalars().all()
        assert rows == [], "a rejected create still recorded a PROVIDER_CREATED event"


# ── 2. The create race ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_the_loser_of_a_slug_race_gets_a_clean_400(
    client, auth_headers, created, monkeypatch
):
    """Two workers, same company name, same moment.

    The competing row is inserted at the point where the real handler makes its
    SMTP round-trip — after both uniqueness pre-checks have passed and before
    the INSERT — which is precisely where production loses the race.
    """
    from tests.conftest import _TestSession

    body = _company("race")
    body.pop("portal_login_email")        # keep this test to the slug index alone
    body.pop("portal_login_password")
    slug = providers_api._slugify(body["name"])

    intruder_id: list[uuid.UUID] = []

    async def _insert_competitor(*_args, **_kwargs):
        async with _TestSession() as other:
            rival = ServiceProvider(name=body["name"] + " (rival)", slug=slug)
            other.add(rival)
            await other.commit()
            intruder_id.append(rival.id)

    monkeypatch.setattr(providers_api, "_verify_new_smtp_credential", _insert_competitor)

    try:
        res = await created(body)

        assert res.status_code != 500, (
            "the create race still surfaces as a 500 — the worker reads that as "
            "an outage and creates a second client under a different name"
        )
        assert res.status_code == 400, f"expected 400, got {res.status_code}: {res.text}"
        assert slug in res.text, (
            f"the 400 does not name the clashing slug, so the worker cannot act "
            f"on it: {res.text}"
        )

        # The database was never corrupted — that was always true, and must stay true.
        async with _TestSession() as db:
            rows = (await db.execute(
                select(ServiceProvider).where(ServiceProvider.slug == slug)
            )).scalars().all()
            assert len(rows) == 1, f"the race created {len(rows)} clients on one slug"

            # And the losing attempt left no audit row behind.
            ghosts = (await db.execute(
                select(AuditLog).where(
                    AuditLog.action == "PROVIDER_CREATED",
                    AuditLog.after_state["name"].astext == body["name"],
                )
            )).scalars().all()
            assert ghosts == [], "the losing attempt recorded a PROVIDER_CREATED event"
    finally:
        for pid in intruder_id:
            async with _TestSession() as db:
                rival = await db.get(ServiceProvider, pid)
                if rival:
                    await db.delete(rival)
                    await db.commit()


@pytest.mark.asyncio
async def test_the_session_still_works_after_a_race_loss(
    client, auth_headers, created, monkeypatch
):
    """An IntegrityError poisons the session; without a rollback the next
    request on it fails too. Retrying is the advice given to the workers, so
    the retry has to actually work."""
    from tests.conftest import _TestSession

    body = _company("retry")
    body.pop("portal_login_email")
    body.pop("portal_login_password")
    slug = providers_api._slugify(body["name"])
    planted: list[uuid.UUID] = []

    async def _insert_competitor(*_args, **_kwargs):
        async with _TestSession() as other:
            rival = ServiceProvider(name=body["name"] + " (rival)", slug=slug)
            other.add(rival)
            await other.commit()
            planted.append(rival.id)

    monkeypatch.setattr(providers_api, "_verify_new_smtp_credential", _insert_competitor)
    first = await client.post("/api/providers", json=body, headers=auth_headers)
    assert first.status_code == 400, first.text
    monkeypatch.undo()

    try:
        # The retry the worker is told to make. It now loses the PRE-CHECK, which
        # is the same 400 by a cleaner route.
        again = await client.post("/api/providers", json=body, headers=auth_headers)
        assert again.status_code == 400, f"the retry did not fail cleanly: {again.status_code}"
        assert slug in again.text

        # An unrelated create on the very next request must still succeed —
        # proof the poisoned session was rolled back rather than left broken.
        ok = await created(_company("after-race"))
        assert ok.status_code in (200, 201), (
            f"a later, unrelated create failed after a race loss: {ok.text}"
        )
    finally:
        for pid in planted:
            async with _TestSession() as db:
                rival = await db.get(ServiceProvider, pid)
                if rival:
                    await db.delete(rival)
                    await db.commit()


# ── 3. The same race on the edit path ────────────────────────────────────────
#
# Editing a client is where a half-finished onboarding gets repaired, so a 500
# here is worse than on create: the worker has already been told to come to this
# screen to fix things.
#
# Every injection point inside update_provider is a SYNCHRONOUS call
# (hash_password, _validate_portal_password), so the competing write cannot be
# awaited on the test's own event loop. It runs on its own thread with its own
# connection instead — which is what a second admin worker literally is.


def _write_from_another_connection(sql: str, *args) -> None:
    import asyncio
    import threading

    import asyncpg

    from tests.conftest import _test_engine

    dsn = _test_engine.url.render_as_string(hide_password=False).replace(
        "postgresql+asyncpg://", "postgresql://"
    )
    failure: list[BaseException] = []

    def _run() -> None:
        async def _go() -> None:
            conn = await asyncpg.connect(dsn)
            try:
                await conn.execute(sql, *args)
            finally:
                await conn.close()

        try:
            asyncio.run(_go())
        except BaseException as exc:  # surfaced below, on the test's thread
            failure.append(exc)

    thread = threading.Thread(target=_run)
    thread.start()
    thread.join()
    if failure:
        raise failure[0]


def _one_shot_injector(monkeypatch, do_write):
    """Fire `do_write` at the first hash_password call, then behave normally.

    hash_password runs after this route's uniqueness pre-checks and before the
    commit, which is precisely the window a concurrent edit lands in.
    """
    real = providers_api.hash_password
    fired: list[int] = []

    def _patched(password):
        if not fired:
            fired.append(1)
            do_write()
        return real(password)

    monkeypatch.setattr(providers_api, "hash_password", _patched)
    return fired


@pytest.mark.asyncio
async def test_a_client_login_race_on_edit_is_a_400_naming_the_owner(
    client, auth_headers, created, monkeypatch
):
    a = await created(_company("edit-a"))
    b = await created(_company("edit-b"))
    assert a.status_code in (200, 201) and b.status_code in (200, 201)
    a_id, b_id = uuid.UUID(a.json()["id"]), b.json()["id"]

    contested = f"contested.{RUN}@audit.test"
    fired = _one_shot_injector(monkeypatch, lambda: _write_from_another_connection(
        "UPDATE service_providers SET portal_login_email = $1 WHERE id = $2",
        contested, a_id,
    ))

    res = await client.patch(
        f"/api/providers/{b_id}",
        json={"portal_login_username": contested, "portal_login_password": "Contest!9aAbc"},
        headers=auth_headers,
    )

    assert fired, "the competing edit never ran — this test proved nothing"
    assert res.status_code != 500, (
        "an edit race still reads as an outage on the screen workers are sent "
        "to when a create half-fails"
    )
    assert res.status_code == 400, f"expected 400, got {res.status_code}: {res.text}"
    assert contested in res.text, res.text
    # The pre-check names the owning client; the race must not explain the same
    # mistake differently just because of timing.
    assert f"Audit {RUN} edit-a" in res.text, (
        f"the 400 does not name the client that owns the login: {res.text}"
    )


@pytest.mark.asyncio
async def test_an_admin_email_race_on_edit_is_a_400_naming_the_owner(
    client, auth_headers, created, monkeypatch
):
    from tests.conftest import _TestSession

    body_a = _company("edit-c")
    body_a["admin_email"] = f"admin.c.{RUN}@audit.test"
    body_a["admin_password"] = "AdminC!9aAbc"
    body_b = _company("edit-d")
    body_b["admin_email"] = f"admin.d.{RUN}@audit.test"
    body_b["admin_password"] = "AdminD!9aAbc"

    a = await created(body_a)
    b = await created(body_b)
    assert a.status_code in (200, 201) and b.status_code in (200, 201), (a.text, b.text)
    a_id, b_id = uuid.UUID(a.json()["id"]), b.json()["id"]

    contested = f"contested.admin.{RUN}@audit.test"
    fired = _one_shot_injector(monkeypatch, lambda: _write_from_another_connection(
        "UPDATE crew_members SET email = $1 WHERE provider_id = $2 AND role = 'admin'",
        contested, a_id,
    ))

    res = await client.patch(
        f"/api/providers/{b_id}",
        json={"admin_email": contested, "admin_password": "Contest!9aAbc"},
        headers=auth_headers,
    )

    assert fired, "the competing edit never ran — this test proved nothing"
    assert res.status_code == 400, f"expected 400, got {res.status_code}: {res.text}"
    assert f"Audit {RUN} edit-c" in res.text, (
        f"the 400 does not name the client that owns the admin email: {res.text}"
    )

    # And client B was left exactly as it was — a refused edit must not apply
    # half of itself.
    async with _TestSession() as db:
        after = await db.get(ServiceProvider, uuid.UUID(b_id))
        assert after.name == body_b["name"]


@pytest.mark.asyncio
async def test_an_edit_race_leaves_the_session_usable(
    client, auth_headers, created, monkeypatch
):
    """Retrying is the advice given to the workers, so the retry has to work."""
    a = await created(_company("edit-e"))
    b = await created(_company("edit-f"))
    a_id, b_id = uuid.UUID(a.json()["id"]), b.json()["id"]

    contested = f"contested2.{RUN}@audit.test"
    _one_shot_injector(monkeypatch, lambda: _write_from_another_connection(
        "UPDATE service_providers SET portal_login_email = $1 WHERE id = $2",
        contested, a_id,
    ))

    lost = await client.patch(
        f"/api/providers/{b_id}",
        json={"portal_login_username": contested, "portal_login_password": "Contest!9aAbc"},
        headers=auth_headers,
    )
    assert lost.status_code == 400, lost.text
    monkeypatch.undo()

    # The retry now loses the PRE-CHECK — same 400, cleaner route.
    again = await client.patch(
        f"/api/providers/{b_id}",
        json={"portal_login_username": contested, "portal_login_password": "Contest!9aAbc"},
        headers=auth_headers,
    )
    assert again.status_code == 400, f"the retry did not fail cleanly: {again.status_code}"

    # And an ordinary edit still goes through.
    ok = await client.patch(
        f"/api/providers/{b_id}", json={"phone": "011 222 3333"}, headers=auth_headers,
    )
    assert ok.status_code == 200, f"an unrelated edit failed after a race loss: {ok.text}"


# ── 4. The mapper's branch order ─────────────────────────────────────────────

def _integrity(detail: str) -> IntegrityError:
    return IntegrityError("INSERT INTO ...", {}, Exception(detail))


@pytest.mark.parametrize(
    "detail,expect",
    [
        # Real Postgres wording, both halves: constraint name and DETAIL line.
        ('duplicate key value violates unique constraint "ix_service_providers_slug"\n'
         'DETAIL:  Key (slug)=(acme-ems) already exists.', "already taken"),
        ('duplicate key value violates unique constraint '
         '"ix_service_providers_portal_login_email"\n'
         'DETAIL:  Key (portal_login_email)=(a@b.test) already exists.', "Portal Login Email"),
        ('duplicate key value violates unique constraint "ix_crew_members_email"\n'
         'DETAIL:  Key (email)=(a@b.test) already exists.', "already registered as a crew member"),
        # An index nobody mapped must still be a 400, not an escape to a 500.
        ('duplicate key value violates unique constraint "ix_something_new"', "already"),
    ],
)
def test_each_unique_index_maps_to_the_message_its_pre_check_gives(detail, expect):
    err = providers_api._duplicate_client_error(
        _integrity(detail),
        slug="acme-ems",
        portal_email="a@b.test",
        admin_email="a@b.test",
    )
    assert err.status_code == 400
    assert expect in err.detail, f"{detail!r} -> {err.detail!r}"


def test_the_portal_login_branch_wins_over_the_bare_email_branch():
    """`portal_login_email` contains `email`. If the branches were ordered the
    other way, a portal-login clash would be reported as a crew-email clash and
    send the worker to edit the wrong field."""
    err = providers_api._duplicate_client_error(
        _integrity('DETAIL:  Key (portal_login_email)=(a@b.test) already exists.'),
        slug="acme-ems", portal_email="a@b.test", admin_email="other@b.test",
    )
    assert "Portal Login Email" in err.detail, err.detail
    assert "crew member" not in err.detail, err.detail


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "detail,expect,forbid",
    [
        ('DETAIL:  Key (portal_login_email)=(a@b.test) already exists.',
         "client login", "admin email"),
        ('DETAIL:  Key (email)=(a@b.test) already exists.',
         "admin email", "client login"),
        # Unmapped constraints must still be a 400, never an escape to a 500.
        ('duplicate key value violates unique constraint "ix_something_new"',
         "already in use", "client login '"),
    ],
)
async def test_the_edit_mapper_picks_the_same_branches(detail, expect, forbid):
    """The edit path's twin has the same ordering hazard, and its owner lookup
    must degrade to a name rather than raise when nothing matches."""
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        err = await providers_api._duplicate_client_edit_error(
            db, _integrity(detail),
            portal_email="a@b.test", admin_email="a@b.test",
        )
    assert err.status_code == 400
    assert expect in err.detail.lower(), err.detail
    assert forbid not in err.detail.lower(), err.detail
