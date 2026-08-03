"""
Bulk session revocation, and the login timing oracle.

TWO DEFECTS, ONE THEME: a control that only works against an attacker who
politely identifies themselves.

  * The JTI blacklist can revoke a token somebody PRESENTS. A token copied off a
    device is never presented by the thief until they use it, and by then it is
    too late — there was no way to invalidate it. "A crew tablet was left at the
    hospital" had no answer but "wait twelve hours".

  * Every login path short-circuited bcrypt for an unknown identity, so response
    time distinguished a real account from a fake one. Lockout does not help:
    enumeration needs one attempt per address, never five against the same one.

The timing tests here do NOT measure a clock. Wall-clock assertions are flaky on
a loaded CI box and would be the first thing muted. They assert the mechanism
instead — that bcrypt is actually entered on the unknown-account path — which is
the property that makes the timing equal.
"""
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.models.crew_member import CrewMember
from app.models.service_provider import ServiceProvider
from app.models.user import User
from app.utils import security as sec
from app.utils.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    token_is_revoked_by_family,
)

pytestmark = pytest.mark.asyncio


# ════════════════════════════════════════════════════════════════════
# The primitive
# ════════════════════════════════════════════════════════════════════

def test_no_revocation_set_allows_everything():
    payload = decode_token(create_access_token({"sub": "x"}))
    assert token_is_revoked_by_family(payload, None) is False


def test_token_issued_before_cutoff_is_revoked():
    payload = decode_token(create_access_token({"sub": "x"}))
    cutoff = datetime.now(timezone.utc) + timedelta(seconds=5)
    assert token_is_revoked_by_family(payload, cutoff) is True


def test_token_issued_after_cutoff_survives():
    payload = decode_token(create_access_token({"sub": "x"}))
    cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
    assert token_is_revoked_by_family(payload, cutoff) is False


def test_token_without_iat_fails_closed():
    """A token minted before `iat` existed cannot prove when it was issued.

    Once an identity has been revoked, an unprovable issue time must count as
    "before" — the alternative is a revocation that silently exempts exactly the
    oldest tokens, which are the ones most likely to have leaked.
    """
    assert token_is_revoked_by_family({"sub": "x"}, datetime.now(timezone.utc)) is True
    assert token_is_revoked_by_family({"sub": "x", "iat": "junk"},
                                      datetime.now(timezone.utc)) is True


def test_naive_cutoff_is_treated_as_utc():
    """Postgres can hand back a naive datetime depending on driver settings.

    Comparing a naive to an aware datetime raises TypeError, and this function
    runs inside get_current_user — so that exception would be a 500 on EVERY
    authenticated request for a revoked account, not a clean 401.
    """
    naive = (datetime.now(timezone.utc) + timedelta(seconds=5)).replace(tzinfo=None)
    payload = decode_token(create_access_token({"sub": "x"}))
    assert token_is_revoked_by_family(payload, naive) is True


def test_sub_second_revocation_is_decided_correctly_in_both_directions():
    """Second granularity is too coarse for the attack this defends against.

    Refresh-token reuse fires MILLISECONDS after the exchange that minted the
    attacker's token. At whole-second resolution the two share a timestamp and
    the attacker's token survives the revocation aimed at it. Rounding the other
    way instead locks out the victim signing straight back in. Only millisecond
    resolution gets both right — and both directions are asserted here because
    fixing one by breaking the other is the obvious wrong repair.
    """
    payload = decode_token(create_access_token({"sub": "x"}))
    issued = datetime.fromtimestamp(payload["iat_ms"] / 1000, tz=timezone.utc)

    # Revoked 400ms AFTER issue, inside the same second: must be revoked.
    assert token_is_revoked_by_family(
        payload, issued + timedelta(milliseconds=400)) is True

    # Issued 400ms AFTER the revocation, inside the same second: must survive.
    assert token_is_revoked_by_family(
        payload, issued - timedelta(milliseconds=400)) is False


def test_tokens_carry_issue_time():
    """Without an issue-time claim the whole mechanism is inert."""
    for token in (create_access_token({"sub": "x"}), create_refresh_token({"sub": "x"})):
        payload = decode_token(token)
        assert isinstance(payload.get("iat"), int)
        assert isinstance(payload.get("iat_ms"), int)


def test_falls_back_to_iat_when_iat_ms_absent():
    """Tokens minted before iat_ms existed must still be revocable."""
    now = datetime.now(timezone.utc)
    legacy = {"sub": "x", "iat": int(now.timestamp())}
    assert token_is_revoked_by_family(legacy, now + timedelta(seconds=10)) is True
    assert token_is_revoked_by_family(legacy, now - timedelta(seconds=10)) is False


# ════════════════════════════════════════════════════════════════════
# The unknown-account timing oracle
# ════════════════════════════════════════════════════════════════════

async def test_missing_hash_still_runs_bcrypt(monkeypatch):
    """The whole point: no hash on file must still cost a hash."""
    calls = []
    real = sec.verify_password

    def spy(plain, hashed):
        calls.append(hashed)
        return real(plain, hashed)

    monkeypatch.setattr(sec, "verify_password", spy)

    assert await sec.verify_password_or_dummy("whatever", None) is False
    assert len(calls) == 1, "unknown account skipped bcrypt — the oracle is back"
    assert calls[0].startswith("$2"), "did not verify against a real bcrypt digest"


async def test_real_hash_still_verifies_normally():
    h = sec.hash_password("Correct-Horse-Battery-9!")
    assert await sec.verify_password_or_dummy("Correct-Horse-Battery-9!", h) is True
    assert await sec.verify_password_or_dummy("wrong", h) is False


async def test_unknown_admin_login_enters_bcrypt(client, monkeypatch):
    """End-to-end: POST /api/auth/login for an address that does not exist."""
    calls = []
    real = sec.verify_password
    monkeypatch.setattr(sec, "verify_password",
                        lambda p, h: (calls.append(h), real(p, h))[1])

    r = await client.post("/api/auth/login", data={
        "username": "definitely-not-a-user@nowhere.invalid",
        "password": "irrelevant",
    })
    assert r.status_code == 401
    assert len(calls) >= 1, "unknown email answered without hashing — timing oracle"


async def test_unknown_crew_login_enters_bcrypt(client, monkeypatch):
    calls = []
    real = sec.verify_password
    monkeypatch.setattr(sec, "verify_password",
                        lambda p, h: (calls.append(h), real(p, h))[1])

    r = await client.post("/api/crew/login", json={
        "email": "no-such-medic@nowhere.invalid", "password": "irrelevant",
    })
    assert r.status_code == 401
    assert len(calls) >= 1


async def test_unknown_provider_slug_unlock_enters_bcrypt(client, monkeypatch):
    """portal-unlock returns a deliberately uniform 401 — make the cost uniform too."""
    calls = []
    real = sec.verify_password
    monkeypatch.setattr(sec, "verify_password",
                        lambda p, h: (calls.append(h), real(p, h))[1])

    r = await client.post("/api/crew/portal-unlock", json={
        "provider_slug": "no-such-company-at-all", "password": "irrelevant",
    })
    assert r.status_code == 401
    assert len(calls) >= 1


# ════════════════════════════════════════════════════════════════════
# Refresh-token reuse == theft
# ════════════════════════════════════════════════════════════════════

@pytest_asyncio.fixture
async def fresh_admin():
    """An admin with no prior revocation stamp."""
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        user = (await db.execute(
            select(User).where(User.email == "admin@emsclaims.co.za")
        )).scalar_one_or_none()
        if user is None:
            pytest.skip("shared admin fixture not present")
        user.tokens_revoked_at = None
        await db.commit()
        return str(user.id)


async def _revoked_at(user_id):
    from tests.conftest import _TestSession
    async with _TestSession() as db:
        return (await db.execute(
            select(User.tokens_revoked_at).where(User.id == user_id)
        )).scalar_one()


async def test_replaying_a_spent_refresh_token_revokes_every_session(client, fresh_admin):
    """Rotation means a legitimate holder never presents the same token twice.

    A second presentation means two parties hold it and we cannot tell which is
    the real user. Previously the replay just 401'd — leaving the token the
    ATTACKER received on the first use valid for its full seven days.
    """
    token = create_refresh_token({"sub": fresh_admin})

    first = await client.post("/api/auth/refresh", json={"refresh_token": token})
    assert first.status_code == 200, first.text
    stolen_access = first.json()["access_token"]
    stolen_refresh = first.json()["refresh_token"]

    assert await _revoked_at(fresh_admin) is None, "nothing revoked yet"

    # The victim's client retries with the same (now spent) token.
    replay = await client.post("/api/auth/refresh", json={"refresh_token": token})
    assert replay.status_code == 401

    assert await _revoked_at(fresh_admin) is not None, \
        "reuse did not revoke the family — the attacker keeps 7 days of access"

    # Everything minted from that first exchange is dead, which is the point.
    me = await client.get("/api/auth/me",
                          headers={"Authorization": f"Bearer {stolen_access}"})
    assert me.status_code == 401, "access token from the stolen exchange still works"

    again = await client.post("/api/auth/refresh", json={"refresh_token": stolen_refresh})
    assert again.status_code == 401, \
        "refresh token from the stolen exchange can still mint — revocation is cosmetic"


async def test_normal_rotation_does_not_revoke_anything(client, fresh_admin):
    """The dangerous failure mode of the test above is over-triggering."""
    token = create_refresh_token({"sub": fresh_admin})
    for _ in range(3):
        r = await client.post("/api/auth/refresh", json={"refresh_token": token})
        assert r.status_code == 200, r.text
        token = r.json()["refresh_token"]
    assert await _revoked_at(fresh_admin) is None, \
        "ordinary rotation tripped the theft response — this would log users out at random"


# ════════════════════════════════════════════════════════════════════
# Crew: the lost-tablet case
# ════════════════════════════════════════════════════════════════════

@pytest_asyncio.fixture
async def crew_row():
    from tests.conftest import _TestSession
    async with _TestSession() as db:
        crew = (await db.execute(
            select(CrewMember).where(CrewMember.email == "crew_a_pytest@emsclaims.test")
        )).scalar_one()
        crew.tokens_revoked_at = None
        await db.commit()
        return {"id": str(crew.id), "provider_id": str(crew.provider_id)}


def _crew_token(crew):
    return create_access_token({
        "sub": crew["id"], "crew_id": crew["id"],
        "provider_id": crew["provider_id"], "token_scope": "crew",
    }, expires_delta=timedelta(hours=12))


async def test_revoking_a_crew_kills_a_token_nobody_ever_presented(client, crew_row):
    """The copied-token case the blacklist structurally cannot reach."""
    from tests.conftest import _TestSession

    stolen = _crew_token(crew_row)          # imagine this lifted off a lost tablet
    ok = await client.get("/api/crew/me", headers={"Authorization": f"Bearer {stolen}"})
    assert ok.status_code == 200, ok.text

    async with _TestSession() as db:
        crew = (await db.execute(
            select(CrewMember).where(CrewMember.id == crew_row["id"])
        )).scalar_one()
        crew.tokens_revoked_at = datetime.now(timezone.utc) + timedelta(seconds=1)
        await db.commit()

    after = await client.get("/api/crew/me", headers={"Authorization": f"Bearer {stolen}"})
    assert after.status_code == 401, "a revoked crew session still reads patient data"


async def test_revoked_crew_token_cannot_be_traded_for_a_new_shift(client, crew_row):
    """require_portal_grant accepts a crew token as proof of device unlock.

    If it did not also honour the cutoff, a revoked session could be exchanged
    for a fresh 12-hour one and the revocation would last exactly one request.
    """
    from tests.conftest import _TestSession

    stolen = _crew_token(crew_row)
    async with _TestSession() as db:
        crew = (await db.execute(
            select(CrewMember).where(CrewMember.id == crew_row["id"])
        )).scalar_one()
        crew.tokens_revoked_at = datetime.now(timezone.utc) + timedelta(seconds=1)
        provider_slug = (await db.execute(
            select(ServiceProvider.slug).where(ServiceProvider.id == crew.provider_id)
        )).scalar_one()
        await db.commit()

    r = await client.post(
        "/api/crew/shift-start-by-id",
        json={"crew_id": crew_row["id"], "provider_slug": provider_slug},
        headers={"Authorization": f"Bearer {stolen}"},
    )
    assert r.status_code == 401, \
        "revoked crew token still mints a fresh 12-hour patient-record session"


async def test_revoking_a_provider_kills_outstanding_device_grants(client):
    """Rotating a leaked company password does not retire grants already minted."""
    from tests.conftest import _TestSession
    from app.api.crew_auth import PORTAL_GRANT_SCOPE

    async with _TestSession() as db:
        provider = (await db.execute(
            select(ServiceProvider).where(ServiceProvider.slug == "pytest-prf-provider")
        )).scalar_one()
        provider.tokens_revoked_at = None
        await db.commit()
        pid, slug = str(provider.id), provider.slug
        crew_id = str((await db.execute(
            select(CrewMember.id).where(CrewMember.provider_id == provider.id)
        )).scalars().first())

    grant = create_access_token(
        {"sub": pid, "provider_id": pid, "provider_slug": slug,
         "token_scope": PORTAL_GRANT_SCOPE},
        expires_delta=timedelta(hours=12),
    )
    body = {"crew_id": crew_id, "provider_slug": slug}
    hdr = {"Authorization": f"Bearer {grant}"}

    before = await client.post("/api/crew/shift-start-by-id", json=body, headers=hdr)
    assert before.status_code == 200, before.text

    async with _TestSession() as db:
        provider = (await db.execute(
            select(ServiceProvider).where(ServiceProvider.id == pid)
        )).scalar_one()
        provider.tokens_revoked_at = datetime.now(timezone.utc) + timedelta(seconds=1)
        await db.commit()

    after = await client.post("/api/crew/shift-start-by-id", json=body, headers=hdr)
    assert after.status_code == 401, \
        "device grant from before the revocation still starts shifts"


# ════════════════════════════════════════════════════════════════════
# The admin door — a capability nobody can invoke is not a capability
# ════════════════════════════════════════════════════════════════════

async def test_revoke_endpoint_requires_admin(client, crew_row):
    r = await client.post("/api/account-security/revoke-sessions",
                          json={"account_type": "crew", "id": crew_row["id"]})
    assert r.status_code in (401, 403)


async def test_admin_can_revoke_and_it_takes_effect(client, auth_headers, crew_row):
    if not auth_headers:
        pytest.skip("admin login unavailable")
    stolen = _crew_token(crew_row)
    assert (await client.get("/api/crew/me",
                             headers={"Authorization": f"Bearer {stolen}"})).status_code == 200

    r = await client.post("/api/account-security/revoke-sessions", headers=auth_headers, json={
        "account_type": "crew", "id": crew_row["id"], "reason": "tablet left at hospital",
    })
    assert r.status_code == 200, r.text

    after = await client.get("/api/crew/me", headers={"Authorization": f"Bearer {stolen}"})
    assert after.status_code == 401


async def test_revoke_rejects_unknown_account_type(client, auth_headers, crew_row):
    if not auth_headers:
        pytest.skip("admin login unavailable")
    r = await client.post("/api/account-security/revoke-sessions", headers=auth_headers,
                          json={"account_type": "wizard", "id": crew_row["id"]})
    assert r.status_code == 400


def test_the_login_decoy_is_prebuilt_at_startup():
    """The residual timing tell, removed.

    verify_password_or_dummy equalises the cost of a known and an unknown
    account — but the decoy digest was generated lazily, so the FIRST unknown
    login in each process cost 2x (512ms vs 254ms, measured on production).
    Four gunicorn workers meant four observably slow responses after every
    deploy. The lifespan now pre-builds it.

    Asserted by INSPECTING the lifespan source, not by running it. Running the
    real lifespan in a test is what this file did first, and it called
    seed_super_admin(), which permanently promoted the shared seed admin to
    SUPER_ADMIN in the test database and broke an unrelated authorisation test.
    A startup hook is not a thing to invoke casually from a test.
    """
    import inspect

    from app.main import lifespan
    from app.utils.security import _dummy_hash

    src = inspect.getsource(lifespan)
    assert "_dummy_hash" in src, (
        "startup no longer pre-builds the login decoy — the first "
        "unknown-account login in each worker will cost twice a real one again"
    )

    # ...and the thing it warms must actually produce a usable bcrypt digest.
    assert _dummy_hash().startswith("$2")
    assert _dummy_hash() == _dummy_hash(), "the decoy must be stable per process"
