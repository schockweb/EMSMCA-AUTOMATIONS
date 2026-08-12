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


# ── 3. The mapper's branch order ─────────────────────────────────────────────

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
