"""
A revoked token must not be exchangeable for a fresh crew session.

require_portal_grant is the gate in front of `shift-start-by-id` and
`lookup-hpcsa`, both of which mint 12-hour tokens that can read, edit and delete
Patient Report Forms. It accepts EITHER a portal grant or an already-valid crew
token for the same provider — the latter so a crew mid-shift can add a colleague
without re-entering the company password.

It validated the signature, the scope and the provider, but never the blacklist
and never the token type. So:

  * a crew token revoked at End Shift could still be traded for a NEW 12-hour
    patient-record token, making logout reversible for the token's remaining
    life; and
  * a 7-day refresh token satisfied the gate, because both families are signed
    with the same key.
"""
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.api.crew_auth import PORTAL_GRANT_SCOPE
from app.models.crew_member import CrewMember
from app.models.service_provider import ServiceProvider
from app.utils.security import (
    blacklist_token,
    create_access_token,
    create_refresh_token,
    decode_token,
)

_PORTAL_PASSWORD = "PortalGrant@Revoke2026!"


@pytest_asyncio.fixture
async def provider_with_portal_password():
    """The shared test provider, with a known portal password set."""
    from tests.conftest import _TestSession
    from app.utils.security import hash_password

    async with _TestSession() as db:
        provider = (await db.execute(
            select(ServiceProvider).where(ServiceProvider.slug == "pytest-prf-provider")
        )).scalar_one()
        provider.portal_login_password_hash = hash_password(_PORTAL_PASSWORD)
        provider.failed_login_attempts = 0
        provider.locked_until = None
        await db.commit()
        return {"id": str(provider.id), "slug": provider.slug}


@pytest_asyncio.fixture
async def crew_id(provider_with_portal_password):
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        crew = (await db.execute(
            select(CrewMember).where(CrewMember.email == "crew_a_pytest@emsclaims.test")
        )).scalar_one()
        return str(crew.id)


def _grant_for(provider) -> str:
    return create_access_token(
        {"sub": provider["id"], "provider_id": provider["id"],
         "provider_slug": provider["slug"], "token_scope": PORTAL_GRANT_SCOPE},
        expires_delta=timedelta(hours=12),
    )


async def _revoke(token: str) -> None:
    from tests.conftest import _TestSession

    payload = decode_token(token)
    async with _TestSession() as db:
        await blacklist_token(
            payload["jti"], None, "access",
            datetime.now(timezone.utc) + timedelta(hours=12), db,
        )
        await db.commit()


# ── The control: a valid grant works ────────────────────────────────────────

@pytest.mark.asyncio
async def test_valid_grant_starts_a_shift(client, provider_with_portal_password, crew_id):
    """Without this, every assertion below could pass for the wrong reason."""
    grant = _grant_for(provider_with_portal_password)
    resp = await client.post(
        "/api/crew/shift-start-by-id",
        headers={"Authorization": f"Bearer {grant}"},
        json={"crew_id": crew_id, "provider_slug": provider_with_portal_password["slug"]},
    )
    assert resp.status_code == 200, f"a valid grant was refused: {resp.text}"
    assert resp.json().get("access_token")


# ── The fixes ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_revoked_grant_cannot_start_a_shift(client, provider_with_portal_password, crew_id):
    grant = _grant_for(provider_with_portal_password)
    await _revoke(grant)

    resp = await client.post(
        "/api/crew/shift-start-by-id",
        headers={"Authorization": f"Bearer {grant}"},
        json={"crew_id": crew_id, "provider_slug": provider_with_portal_password["slug"]},
    )
    assert resp.status_code == 401, (
        f"a REVOKED device unlock still minted a crew session ({resp.status_code})"
    )


@pytest.mark.asyncio
async def test_revoked_grant_cannot_look_up_hpcsa(client, provider_with_portal_password):
    """The other route behind the same gate — it mints a token too."""
    grant = _grant_for(provider_with_portal_password)
    await _revoke(grant)

    resp = await client.post(
        "/api/crew/lookup-hpcsa",
        headers={"Authorization": f"Bearer {grant}"},
        json={"hpcsa_number": "TEST0001", "provider_slug": provider_with_portal_password["slug"]},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_refresh_token_cannot_unlock_a_device(client, provider_with_portal_password, crew_id):
    """Same signing key, same claims — only `type` distinguishes them."""
    refresh = create_refresh_token(
        {"sub": provider_with_portal_password["id"],
         "provider_id": provider_with_portal_password["id"],
         "provider_slug": provider_with_portal_password["slug"],
         "token_scope": PORTAL_GRANT_SCOPE},
    )
    resp = await client.post(
        "/api/crew/shift-start-by-id",
        headers={"Authorization": f"Bearer {refresh}"},
        json={"crew_id": crew_id, "provider_slug": provider_with_portal_password["slug"]},
    )
    assert resp.status_code == 401, (
        f"a REFRESH token unlocked a device ({resp.status_code})"
    )


@pytest.mark.asyncio
async def test_grant_for_another_provider_is_still_refused(client, provider_with_portal_password, crew_id):
    """Pre-existing tenant guard — asserted so the new checks cannot displace it."""
    foreign = create_access_token(
        {"sub": "x", "provider_id": "00000000-0000-0000-0000-000000000001",
         "provider_slug": "someone-else", "token_scope": PORTAL_GRANT_SCOPE},
        expires_delta=timedelta(hours=12),
    )
    resp = await client.post(
        "/api/crew/shift-start-by-id",
        headers={"Authorization": f"Bearer {foreign}"},
        json={"crew_id": crew_id, "provider_slug": provider_with_portal_password["slug"]},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_no_grant_at_all_is_refused(client, provider_with_portal_password, crew_id):
    resp = await client.post(
        "/api/crew/shift-start-by-id",
        json={"crew_id": crew_id, "provider_slug": provider_with_portal_password["slug"]},
    )
    assert resp.status_code == 401
