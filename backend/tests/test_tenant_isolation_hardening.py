"""
Cross-tenant leaks that the earlier isolation work did not reach.

Both are shaped the same way: a guard exists and is correct, but one code path
walks around it.
"""
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.models.crew_member import CrewMember
from app.models.service_provider import ServiceProvider
from app.models.user import User, UserRole
from app.models.vehicle import Vehicle
from app.utils.security import hash_password

_LOW_PRIV_EMAIL = "paramedic_tenant_pytest@emsclaims.test"
_PASSWORD = "TenantTest@2026!Strong"

_RIVAL_SLUG = "pytest-rival-provider"


@pytest_asyncio.fixture
async def low_priv_headers(client):
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        existing = (await db.execute(
            select(User).where(User.email == _LOW_PRIV_EMAIL)
        )).scalar_one_or_none()
        if existing is None:
            db.add(User(
                email=_LOW_PRIV_EMAIL,
                hashed_password=hash_password(_PASSWORD),
                full_name="Tenant Fixture Paramedic",
                role=UserRole.PARAMEDIC,
                bhf_practice_number="0000000",
            ))
            await db.commit()

    resp = await client.post(
        "/api/auth/login", data={"username": _LOW_PRIV_EMAIL, "password": _PASSWORD}
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


@pytest_asyncio.fixture
async def rival_provider():
    """A SECOND provider — the competitor whose data must stay invisible."""
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        provider = (await db.execute(
            select(ServiceProvider).where(ServiceProvider.slug == _RIVAL_SLUG)
        )).scalar_one_or_none()
        if provider is None:
            provider = ServiceProvider(
                name="PyTest Rival Ambulance Co",
                slug=_RIVAL_SLUG,
                pr_number="TEST-PR-RIVAL",
                is_active=True,
            )
            db.add(provider)
            await db.flush()

        crew = (await db.execute(
            select(CrewMember).where(CrewMember.email == "rival_crew_pytest@emsclaims.test")
        )).scalar_one_or_none()
        if crew is None:
            crew = CrewMember(
                provider_id=provider.id,
                email="rival_crew_pytest@emsclaims.test",
                hashed_password=hash_password("Rival@PRF2026!"),
                full_name="Rival Secret Employee",
                initials="RSE",
                qualification="ECP",
                hpcsa_number="RIVAL999",
                is_active=True,
                role="crew",
            )
            db.add(crew)
            await db.flush()

        vehicle = (await db.execute(
            select(Vehicle).where(Vehicle.provider_id == provider.id)
        )).scalars().first()
        if vehicle is None:
            vehicle = Vehicle(
                provider_id=provider.id,
                callsign="RIVAL-01",
                registration="RIVAL 001 GP",   # NOT NULL
                is_active=True,
            )
            db.add(vehicle)
            await db.flush()

        await db.commit()
        return {"provider_id": str(provider.id), "crew_id": str(crew.id), "vehicle_id": str(vehicle.id)}


@pytest_asyncio.fixture
async def crew_token(client):
    """A crew session for the ORIGINAL test provider."""
    from tests.conftest import _TestSession
    from app.utils.security import create_access_token
    from datetime import timedelta

    async with _TestSession() as db:
        crew = (await db.execute(
            select(CrewMember).where(CrewMember.email == "crew_a_pytest@emsclaims.test")
        )).scalar_one()
        token = create_access_token(
            {"sub": str(crew.id), "crew_id": str(crew.id),
             "provider_id": str(crew.provider_id), "token_scope": "crew"},
            expires_delta=timedelta(hours=12),
        )
        return {"Authorization": f"Bearer {token}"}


# ── 1. Failed-PRF queue exposed every tenant's patient records ─────────────

@pytest.mark.asyncio
async def test_failed_prf_list_denied_to_low_privilege_user(client, low_priv_headers):
    """form_data here carries patient name, SA ID number and clinical notes,
    for every provider on the instance."""
    resp = await client.get("/api/failed-prfs", headers=low_priv_headers)
    assert resp.status_code == 403, (
        f"low-privilege user listed every tenant's failed PRFs ({resp.status_code})"
    )


@pytest.mark.asyncio
async def test_failed_prf_detail_denied_to_low_privilege_user(client, low_priv_headers):
    resp = await client.get(f"/api/failed-prfs/{uuid.uuid4()}", headers=low_priv_headers)
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_failed_prf_stats_denied_to_low_privilege_user(client, low_priv_headers):
    resp = await client.get("/api/failed-prfs/stats", headers=low_priv_headers)
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_failed_prf_correct_denied_to_low_privilege_user(client, low_priv_headers):
    """The write path lets the caller rewrite another tenant's clinical record."""
    resp = await client.put(
        f"/api/failed-prfs/{uuid.uuid4()}/correct",
        headers=low_priv_headers,
        json={"form_data": {"patient_name": "Overwritten"}},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_failed_prf_reprocess_denied_to_low_privilege_user(client, low_priv_headers):
    resp = await client.post(
        f"/api/failed-prfs/{uuid.uuid4()}/reprocess", headers=low_priv_headers
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_failed_prf_queue_still_works_for_admin(client, auth_headers):
    """Back-office admins fix failed PRFs across every provider — that is the
    point of the queue, and the role gate must not break it."""
    if auth_headers is None:
        pytest.skip("seed admin unavailable")
    resp = await client.get("/api/failed-prfs", headers=auth_headers)
    assert resp.status_code == 200, f"ADMIN blocked from the failed-PRF queue: {resp.text}"


# ── 2. PRF create accepted another provider's crew and vehicle ─────────────

@pytest.mark.asyncio
async def test_create_prf_rejects_foreign_crew_member(client, crew_token, rival_provider):
    """Reading back the PRF would expose the rival's employee name, initials,
    HPCSA registration number and qualification."""
    resp = await client.post(
        "/api/digital-prf",
        headers=crew_token,
        json={"crew_member_2_id": rival_provider["crew_id"]},
    )
    assert resp.status_code == 400, (
        f"a foreign crew member was attached to a PRF ({resp.status_code}): {resp.text[:200]}"
    )


@pytest.mark.asyncio
async def test_create_prf_rejects_foreign_vehicle(client, crew_token, rival_provider):
    resp = await client.post(
        "/api/digital-prf",
        headers=crew_token,
        json={"vehicle_id": rival_provider["vehicle_id"]},
    )
    assert resp.status_code == 400, (
        f"a foreign vehicle was attached to a PRF ({resp.status_code}): {resp.text[:200]}"
    )


@pytest.mark.asyncio
async def test_create_prf_still_works_with_no_partner(client, crew_token):
    """The single-crew case must keep working — most PRFs have no second crew."""
    resp = await client.post("/api/digital-prf", headers=crew_token, json={})
    assert resp.status_code == 201, f"plain PRF create broke: {resp.text[:300]}"


@pytest.mark.asyncio
async def test_create_prf_accepts_own_provider_crew(client, crew_token):
    """And attaching a colleague from the SAME provider must still be allowed,
    otherwise the guard is simply blanket-deny."""
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        colleague = (await db.execute(
            select(CrewMember).where(CrewMember.email == "crew_b_pytest@emsclaims.test")
        )).scalar_one()
        colleague_id = str(colleague.id)

    resp = await client.post(
        "/api/digital-prf", headers=crew_token, json={"crew_member_2_id": colleague_id}
    )
    assert resp.status_code == 201, (
        f"a legitimate same-provider partner was rejected: {resp.text[:300]}"
    )
