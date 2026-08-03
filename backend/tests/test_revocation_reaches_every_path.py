"""
Every way to authenticate must honour bulk session revocation.

THE BUG THIS EXISTS TO PREVENT, WHICH HAS NOW HAPPENED TWICE
------------------------------------------------------------
Two functions decode a bearer token themselves instead of depending on
`get_current_user` / `get_current_crew`:

  * `digital_prf._resolve_case_prf_access` — the sole authorisation for the
    routes that return a FULL clinical record and that email it out
  * `providers.get_admin_or_crew_admin` — ~32 endpoints including the portal
    password, SMTP credentials, crew CRUD and the provider PRF list

In 2026-07 they were retrofitted with the blacklist and `is_active` checks after
the same omission was found. In 2026-08 `tokens_revoked_at` shipped into the
shared dependencies and did not reach them either — so "a crew tablet was left
at the hospital, revoke it" did nothing on precisely the route that reads the
patient record. The JTI blacklist cannot substitute: a COPIED token is never
presented to logout, which is the whole reason the cutoff exists.

A grep-based structural test rather than only per-route requests: the point is
to fail when a THIRD hand-rolled decoder appears, including on routes that do
not exist yet.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.models.crew_member import CrewMember
from app.models.user import User
from app.utils.security import create_access_token

pytestmark = pytest.mark.asyncio

_API = Path(__file__).resolve().parents[1] / "app" / "api"


def test_every_hand_rolled_token_decoder_checks_bulk_revocation():
    """Structural guard: decode a token yourself, check the cutoff yourself.

    Fails on a new file that calls decode_token without also calling
    token_is_revoked_by_family — which is how both previous omissions would
    have been caught before shipping.
    """
    offenders = []
    for path in sorted(_API.glob("*.py")):
        src = path.read_text(encoding="utf-8", errors="ignore")
        if "decode_token" not in src:
            continue
        # auth.py mints and rotates tokens; crashes.py decodes only for
        # best-effort attribution and returns no data on the strength of it.
        if path.name in {"auth.py", "crashes.py"}:
            continue
        if "token_is_revoked_by_family" not in src:
            offenders.append(path.name)

    assert not offenders, (
        f"{offenders} decode a bearer token directly but never check "
        "tokens_revoked_at, so bulk session revocation does not reach the "
        "routes they guard. Either call token_is_revoked_by_family after "
        "loading the principal, or depend on get_current_user / "
        "get_current_crew instead of re-implementing them."
    )


@pytest_asyncio.fixture
async def revoked_crew():
    """A crew member whose sessions were revoked one second from now.

    The cutoff is in the FUTURE so a token minted in this test is
    unambiguously 'before' it without depending on clock resolution.
    """
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        crew = (await db.execute(
            select(CrewMember).where(CrewMember.email == "crew_a_pytest@emsclaims.test")
        )).scalar_one()
        token = create_access_token({
            "sub": str(crew.id), "crew_id": str(crew.id),
            "provider_id": str(crew.provider_id), "token_scope": "crew",
        }, expires_delta=timedelta(hours=12))
        crew.tokens_revoked_at = datetime.now(timezone.utc) + timedelta(seconds=1)
        await db.commit()
        yield {"token": token, "provider_id": str(crew.provider_id)}

    async with _TestSession() as db:
        crew = (await db.execute(
            select(CrewMember).where(CrewMember.email == "crew_a_pytest@emsclaims.test")
        )).scalar_one()
        crew.tokens_revoked_at = None
        await db.commit()


@pytest_asyncio.fixture
async def revoked_admin():
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        user = (await db.execute(
            select(User).where(User.email == "admin@emsclaims.co.za")
        )).scalar_one()
        token = create_access_token({"sub": str(user.id)})
        user.tokens_revoked_at = datetime.now(timezone.utc) + timedelta(seconds=1)
        await db.commit()
        yield token

    async with _TestSession() as db:
        user = (await db.execute(
            select(User).where(User.email == "admin@emsclaims.co.za")
        )).scalar_one()
        user.tokens_revoked_at = None
        await db.commit()


async def test_revoked_crew_cannot_reach_the_provider_endpoints(client, revoked_crew):
    """get_admin_or_crew_admin guards ~32 endpoints including the portal password."""
    hdr = {"Authorization": f"Bearer {revoked_crew['token']}"}
    res = await client.get(
        f"/api/providers/{revoked_crew['provider_id']}/crew", headers=hdr
    )
    assert res.status_code == 401, (
        f"a revoked crew token still reached the provider crew list ({res.status_code}) "
        "— bulk revocation does not cover get_admin_or_crew_admin"
    )


async def test_revoked_admin_cannot_reach_the_provider_endpoints(client, revoked_admin):
    hdr = {"Authorization": f"Bearer {revoked_admin}"}
    res = await client.get("/api/providers", headers=hdr)
    assert res.status_code == 401, (
        f"a revoked admin token still reached the provider list ({res.status_code})"
    )


async def test_revoked_admin_cannot_read_a_full_clinical_record(client, revoked_admin):
    """_resolve_case_prf_access — the widest PHI response in the product.

    A 404 would also mean "did not read a record", so the assertion is on 401
    specifically: the request must be refused at authentication, before the
    case is even looked up.
    """
    hdr = {"Authorization": f"Bearer {revoked_admin}"}
    res = await client.get(
        "/api/digital-prf/admin/by-case/00000000-0000-0000-0000-000000000000",
        headers=hdr,
    )
    assert res.status_code == 401, (
        f"a revoked admin token was still authenticated for a clinical record "
        f"read ({res.status_code})"
    )


async def test_a_live_token_is_unaffected(client):
    """The dangerous failure mode of all of the above is refusing everyone."""
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        user = (await db.execute(
            select(User).where(User.email == "admin@emsclaims.co.za")
        )).scalar_one()
        user.tokens_revoked_at = None
        await db.commit()
        token = create_access_token({"sub": str(user.id)})

    res = await client.get("/api/providers", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200, (
        f"a valid admin token was refused ({res.status_code}) — the revocation "
        "check is rejecting live sessions"
    )
