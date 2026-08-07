"""
Deactivating a client, which is what "delete a client" always had to mean.

A provider cannot be deleted once it has been used: `audit_logs.crew_member_id`
records which crew member opened which patient's file and the table is
append-only, so the foreign key cannot be cleared out of the way. That refusal
used to surface as a 500 "An internal error occurred", which reads as a crash.

What is asserted here:

  1. Deactivation carries to the crew. The provider flag alone leaves every
     paramedic able to start a shift.
  2. A crew token already in a tablet's storage dies on the next request —
     not in twelve hours' time.
  3. Reactivation restores the crew the cascade switched off, and ONLY those.
     A paramedic deactivated individually (the one who left) stays out.
  4. Delete refuses with an explanatory 409 once there is clinical history, and
     still works for a client created by mistake and never used.
"""
from datetime import timedelta

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.models.audit_log import AuditLog
from app.models.crew_member import CrewMember
from app.models.service_provider import ServiceProvider
from app.utils.security import create_access_token, hash_password

_SLUG = "pytest-deactivate-co"
_PORTAL_PASSWORD = "Deactivate@Portal2026!"

# Two crew: one carried by the cascade, one already gone from the company.
_STAYING = "deact_staying_pytest@emsclaims.test"
_LEAVER = "deact_leaver_pytest@emsclaims.test"


@pytest_asyncio.fixture
async def client_co():
    """A provider with one active crew member and one individual leaver.

    Reset on every test rather than created once: these tests deactivate the
    thing they share, and a leftover deactivated provider would make whichever
    test ran next pass or fail for the wrong reason.
    """
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        provider = (await db.execute(
            select(ServiceProvider).where(ServiceProvider.slug == _SLUG)
        )).scalar_one_or_none()
        if provider is None:
            provider = ServiceProvider(
                name="PyTest Deactivation Ambulance Co",
                slug=_SLUG,
                pr_number="TEST-PR-DEACT",
            )
            db.add(provider)
            await db.flush()

        provider.is_active = True
        provider.portal_login_email = f"{_SLUG}@emsclaims.test"
        provider.portal_login_password_hash = hash_password(_PORTAL_PASSWORD)

        crew = {}
        for email, name, hpcsa, active in (
            (_STAYING, "PyTest Deact Staying", "DEACT001", True),
            (_LEAVER, "PyTest Deact Leaver", "DEACT002", False),
        ):
            row = (await db.execute(
                select(CrewMember).where(CrewMember.email == email)
            )).scalar_one_or_none()
            if row is None:
                row = CrewMember(
                    provider_id=provider.id,
                    email=email,
                    hashed_password=hash_password("Deact@PRF2026!"),
                    full_name=name,
                    initials="PD",
                    qualification="AEA",
                    hpcsa_number=hpcsa,
                    role="crew",
                )
                db.add(row)
                await db.flush()
            row.is_active = active
            # The leaver was deactivated INDIVIDUALLY — never by a cascade.
            row.deactivated_with_provider = False
            row.tokens_revoked_at = None
            crew[email] = row

        await db.commit()
        return {
            "provider_id": str(provider.id),
            "slug": provider.slug,
            "staying_id": str(crew[_STAYING].id),
            "leaver_id": str(crew[_LEAVER].id),
        }


async def _crew_flags(email: str) -> tuple[bool, bool]:
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        row = (await db.execute(
            select(CrewMember).where(CrewMember.email == email)
        )).scalar_one()
        return row.is_active, row.deactivated_with_provider


async def _provider_active(slug: str) -> bool:
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        return (await db.execute(
            select(ServiceProvider).where(ServiceProvider.slug == slug)
        )).scalar_one().is_active


# ── 1. The cascade ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_deactivate_cascades_to_crew(client, auth_headers, client_co):
    resp = await client.post(
        f"/api/providers/{client_co['provider_id']}/deactivate", headers=auth_headers
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_active"] is False
    assert resp.json()["crew_affected"] == 1, "only the ACTIVE crew member should be counted"

    assert not await _provider_active(_SLUG)
    assert await _crew_flags(_STAYING) == (False, True)
    # The leaver was already off and must not be re-marked as a cascade victim,
    # or reactivating the company would give them their login back.
    assert await _crew_flags(_LEAVER) == (False, False)


@pytest.mark.asyncio
async def test_deactivated_client_disappears_from_sign_in(client, auth_headers, client_co):
    listed = await client.get("/api/providers/public")
    assert any(p["slug"] == _SLUG for p in listed.json()), "fixture provider should start visible"

    # A grant minted BEFORE deactivation — the realistic case is a tablet that
    # was unlocked this morning and is still sitting in the ambulance.
    unlock = await client.post(
        "/api/crew/portal-unlock",
        json={"provider_slug": _SLUG, "password": _PORTAL_PASSWORD},
    )
    assert unlock.status_code == 200, unlock.text
    grant = unlock.json()["grant"]

    resp = await client.post(
        f"/api/providers/{client_co['provider_id']}/deactivate", headers=auth_headers
    )
    assert resp.status_code == 200, resp.text

    listed = await client.get("/api/providers/public")
    assert not any(p["slug"] == _SLUG for p in listed.json())

    start = await client.post(
        "/api/crew/shift-start-by-id",
        json={"crew_id": client_co["staying_id"], "provider_slug": _SLUG},
        headers={"Authorization": f"Bearer {grant}"},
    )
    assert start.status_code == 404, (
        f"a pre-existing device unlock still started a shift for a deactivated "
        f"client: {start.status_code} {start.text}"
    )


@pytest.mark.asyncio
async def test_live_crew_token_stops_working(client, auth_headers, client_co):
    """The 12-hour token already on the tablet, not a fresh sign-in."""
    token = create_access_token(
        {"sub": client_co["staying_id"], "crew_id": client_co["staying_id"],
         "provider_id": client_co["provider_id"], "provider_slug": _SLUG,
         "role": "crew", "token_scope": "crew"},
        expires_delta=timedelta(hours=12),
    )
    headers = {"Authorization": f"Bearer {token}"}

    assert (await client.get("/api/crew/me", headers=headers)).status_code == 200

    resp = await client.post(
        f"/api/providers/{client_co['provider_id']}/deactivate", headers=auth_headers
    )
    assert resp.status_code == 200, resp.text

    after = await client.get("/api/crew/me", headers=headers)
    assert after.status_code == 401, (
        f"a crew session survived its company being deactivated: "
        f"{after.status_code} {after.text}"
    )


# ── 2. Reversibility, without resurrecting the leaver ──────────────────────

@pytest.mark.asyncio
async def test_reactivate_restores_only_cascaded_crew(client, auth_headers, client_co):
    pid = client_co["provider_id"]
    assert (await client.post(f"/api/providers/{pid}/deactivate", headers=auth_headers)).status_code == 200

    resp = await client.post(f"/api/providers/{pid}/reactivate", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_active"] is True
    assert resp.json()["crew_affected"] == 1

    assert await _provider_active(_SLUG)
    assert await _crew_flags(_STAYING) == (True, False)
    assert await _crew_flags(_LEAVER) == (False, False), (
        "reactivating the client handed a login back to a paramedic who had been "
        "deactivated individually"
    )


@pytest.mark.asyncio
async def test_crew_cannot_be_reactivated_under_a_deactivated_client(client, auth_headers, client_co):
    pid = client_co["provider_id"]
    assert (await client.post(f"/api/providers/{pid}/deactivate", headers=auth_headers)).status_code == 200

    resp = await client.patch(
        f"/api/providers/{pid}/crew/{client_co['staying_id']}",
        json={"is_active": True},
        headers=auth_headers,
    )
    assert resp.status_code == 409, resp.text
    assert await _crew_flags(_STAYING) == (False, True)


@pytest.mark.asyncio
async def test_patch_is_active_uses_the_same_cascade(client, auth_headers, client_co):
    """The legacy `is_active` field on PATCH must not bypass the crew cascade."""
    resp = await client.patch(
        f"/api/providers/{client_co['provider_id']}",
        json={"is_active": False},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    assert await _crew_flags(_STAYING) == (False, True)


# ── 3. Delete ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_delete_refuses_once_there_is_patient_access_history(client, auth_headers, client_co):
    from tests.conftest import _TestSession
    import uuid as _uuid

    async with _TestSession() as db:
        db.add(AuditLog(
            crew_member_id=_uuid.UUID(client_co["staying_id"]),
            action="READ",
            entity_type="digital_prf",
            entity_id=_uuid.uuid4(),
            details={"note": "pytest fixture — provider deletion guard"},
        ))
        await db.commit()

    resp = await client.delete(
        f"/api/providers/{client_co['provider_id']}", headers=auth_headers
    )
    assert resp.status_code == 409, (
        f"expected an explanatory refusal, got {resp.status_code} {resp.text}"
    )
    detail = resp.json()["detail"]
    assert "eactivate" in detail, f"the refusal must point at deactivation: {detail}"

    # And the client is still there.
    async with _TestSession() as db:
        assert (await db.execute(
            select(ServiceProvider).where(ServiceProvider.slug == _SLUG)
        )).scalar_one_or_none() is not None


@pytest.mark.asyncio
async def test_delete_still_removes_a_client_created_by_mistake(client, auth_headers):
    """No PRFs, no crew, no access history — nothing to orphan."""
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        provider = ServiceProvider(name="PyTest Typo Co", slug="pytest-typo-co")
        db.add(provider)
        await db.commit()
        pid = str(provider.id)

    resp = await client.delete(f"/api/providers/{pid}", headers=auth_headers)
    assert resp.status_code == 204, resp.text

    async with _TestSession() as db:
        assert (await db.execute(
            select(ServiceProvider).where(ServiceProvider.slug == "pytest-typo-co")
        )).scalar_one_or_none() is None
