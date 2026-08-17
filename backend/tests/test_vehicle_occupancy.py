"""
Vehicle occupancy — the shift-start "already in use" warning.

The feature is advisory, which makes it exactly the kind of thing that rots
unnoticed: nothing breaks when it is wrong, it just stops warning, or starts
warning about a vehicle standing in the yard. Both failures are silent, so the
rules are pinned here rather than trusted.

What is covered:
  * a free vehicle reports free, a claimed one reports who is on it
  * End Shift frees it, and a released vehicle warns nobody
  * an unclosed shift past the staleness window stops counting  <- no scheduler
  * one crew moving to a second vehicle frees the first
  * re-claiming the same vehicle updates the row instead of stacking duplicates
  * the endpoint is behind the device unlock and cannot be used to probe
    another company's fleet
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.api.crew_auth import PORTAL_GRANT_SCOPE
from app.models.crew_member import CrewMember
from app.models.crew_shift import STALE_AFTER_HOURS, CrewShift
from app.models.service_provider import ServiceProvider
from app.models.vehicle import Vehicle
from app.services.vehicle_occupancy import (
    claim_vehicle,
    describe,
    open_shift_for_vehicle,
    release_crew,
)
from app.utils.security import create_access_token

from tests.conftest import _TestSession


def _grant(provider_id, slug="pytest-prf-provider") -> dict:
    """Headers for a device that has entered the company password."""
    token = create_access_token(
        {"sub": str(provider_id), "provider_id": str(provider_id),
         "provider_slug": slug, "token_scope": PORTAL_GRANT_SCOPE},
        expires_delta=timedelta(hours=12),
    )
    return {"Authorization": f"Bearer {token}"}


@pytest_asyncio.fixture
async def fleet():
    """Provider + two vehicles + two crew, cleaned up afterwards."""
    async with _TestSession() as db:
        provider = (await db.execute(
            select(ServiceProvider).where(ServiceProvider.slug == "pytest-prf-provider")
        )).scalar_one()

        v1 = Vehicle(provider_id=provider.id, callsign="PYTEST ALPHA 1",
                     registration="PT 111-111", vehicle_type="Ambulance")
        v2 = Vehicle(provider_id=provider.id, callsign="PYTEST ALPHA 2",
                     registration="PT 222-222", vehicle_type="Ambulance")
        db.add_all([v1, v2])

        crew = (await db.execute(
            select(CrewMember).where(CrewMember.email == "crew_a_pytest@emsclaims.test")
        )).scalar_one()
        crew_b = (await db.execute(
            select(CrewMember).where(CrewMember.email == "crew_b_pytest@emsclaims.test")
        )).scalar_one()

        await db.commit()
        ids = (provider.id, v1.id, v2.id, crew.id, crew_b.id)

    yield ids

    async with _TestSession() as db:
        for s in (await db.execute(
            select(CrewShift).where(CrewShift.vehicle_id.in_([ids[1], ids[2]]))
        )).scalars().all():
            await db.delete(s)
        for v in (await db.execute(
            select(Vehicle).where(Vehicle.id.in_([ids[1], ids[2]]))
        )).scalars().all():
            await db.delete(v)
        await db.commit()


@pytest.mark.asyncio
async def test_free_vehicle_reports_free(fleet):
    _, v1, _, _, _ = fleet
    async with _TestSession() as db:
        assert await open_shift_for_vehicle(db, v1) is None
        assert describe(None) == {"in_use": False}


@pytest.mark.asyncio
async def test_claimed_vehicle_names_the_crew_on_it(fleet):
    provider, v1, _, crew, _ = fleet
    async with _TestSession() as db:
        await claim_vehicle(
            db, provider_id=provider, crew_member_id=crew, vehicle_id=v1,
            vehicle_callsign="PYTEST ALPHA 1", crew_name="PyTest Crew Alpha",
            partner_name="PyTest Crew Bravo",
        )
        await db.commit()

    async with _TestSession() as db:
        out = describe(await open_shift_for_vehicle(db, v1))

    assert out["in_use"] is True
    assert out["crew_name"] == "PyTest Crew Alpha"
    assert out["partner_name"] == "PyTest Crew Bravo"
    # The warning is useless without a time to put to it.
    assert out["since"] and out["minutes_ago"] >= 0


@pytest.mark.asyncio
async def test_end_shift_frees_the_vehicle(fleet):
    provider, v1, _, crew, _ = fleet
    async with _TestSession() as db:
        await claim_vehicle(db, provider_id=provider, crew_member_id=crew,
                            vehicle_id=v1, vehicle_callsign="PYTEST ALPHA 1")
        await db.commit()

    async with _TestSession() as db:
        assert await release_crew(db, crew, "crew") == 1
        await db.commit()

    async with _TestSession() as db:
        assert await open_shift_for_vehicle(db, v1) is None


@pytest.mark.asyncio
async def test_stale_open_shift_stops_counting(fleet):
    """The whole staleness design, in one assertion.

    Nothing closes a shift when a tablet dies mid-duty, so if an open row were
    believed forever the vehicle would be warned about permanently. Expiry is
    evaluated at read time precisely so no scheduler has to be alive for the
    answer to be right — which is why this test moves the clock on the ROW and
    does not run a sweeper.
    """
    provider, v1, _, crew, _ = fleet
    async with _TestSession() as db:
        shift = await claim_vehicle(db, provider_id=provider, crew_member_id=crew,
                                    vehicle_id=v1, vehicle_callsign="PYTEST ALPHA 1")
        await db.flush()
        shift.started_at = datetime.now(timezone.utc) - timedelta(hours=STALE_AFTER_HOURS + 1)
        await db.commit()

    async with _TestSession() as db:
        assert await open_shift_for_vehicle(db, v1) is None, \
            "an abandoned shift must stop occupying the vehicle without a sweeper running"


@pytest.mark.asyncio
async def test_just_inside_the_window_still_counts(fleet):
    """The other side of the boundary — 13h in is still a live shift."""
    provider, v1, _, crew, _ = fleet
    async with _TestSession() as db:
        shift = await claim_vehicle(db, provider_id=provider, crew_member_id=crew,
                                    vehicle_id=v1, vehicle_callsign="PYTEST ALPHA 1")
        await db.flush()
        shift.started_at = datetime.now(timezone.utc) - timedelta(hours=STALE_AFTER_HOURS - 1)
        await db.commit()

    async with _TestSession() as db:
        assert await open_shift_for_vehicle(db, v1) is not None


@pytest.mark.asyncio
async def test_moving_to_another_vehicle_frees_the_first(fleet):
    """A crew cannot be on two ambulances.

    Without this the first vehicle stays flagged for 14 hours and the next crew
    is warned off an ambulance sitting free — the exact failure this feature is
    supposed to prevent, caused by the feature itself.
    """
    provider, v1, v2, crew, _ = fleet
    async with _TestSession() as db:
        await claim_vehicle(db, provider_id=provider, crew_member_id=crew,
                            vehicle_id=v1, vehicle_callsign="PYTEST ALPHA 1")
        await db.commit()
    async with _TestSession() as db:
        await claim_vehicle(db, provider_id=provider, crew_member_id=crew,
                            vehicle_id=v2, vehicle_callsign="PYTEST ALPHA 2")
        await db.commit()

    async with _TestSession() as db:
        assert await open_shift_for_vehicle(db, v1) is None
        assert await open_shift_for_vehicle(db, v2) is not None


@pytest.mark.asyncio
async def test_reclaiming_the_same_vehicle_does_not_stack_rows(fleet):
    """Both shift-start flows can claim the same vehicle for the same crew.

    If each wrote a row, End Shift would close one and leave the other open,
    and the vehicle would stay flagged after the crew went home.
    """
    provider, v1, _, crew, _ = fleet
    for _ in range(3):
        async with _TestSession() as db:
            await claim_vehicle(db, provider_id=provider, crew_member_id=crew,
                                vehicle_id=v1, vehicle_callsign="PYTEST ALPHA 1")
            await db.commit()

    async with _TestSession() as db:
        open_rows = (await db.execute(
            select(CrewShift).where(
                CrewShift.vehicle_id == v1, CrewShift.ended_at.is_(None)
            )
        )).scalars().all()
    assert len(open_rows) == 1

    async with _TestSession() as db:
        assert await release_crew(db, crew, "crew") == 1
        await db.commit()
    async with _TestSession() as db:
        assert await open_shift_for_vehicle(db, v1) is None


@pytest.mark.asyncio
async def test_two_crews_on_one_vehicle_reports_the_newest(fleet):
    """Once a second crew takes the vehicle anyway, they are the ones on it."""
    provider, v1, _, crew_a, crew_b = fleet
    async with _TestSession() as db:
        first = await claim_vehicle(db, provider_id=provider, crew_member_id=crew_a,
                                    vehicle_id=v1, vehicle_callsign="PYTEST ALPHA 1",
                                    crew_name="PyTest Crew Alpha")
        await db.flush()
        # Backdate rather than race the clock — two claims a millisecond apart
        # would make the ordering, and this test, a coin toss.
        first.started_at = datetime.now(timezone.utc) - timedelta(hours=2)
        await db.commit()
    async with _TestSession() as db:
        await claim_vehicle(db, provider_id=provider, crew_member_id=crew_b,
                            vehicle_id=v1, vehicle_callsign="PYTEST ALPHA 1",
                            crew_name="PyTest Crew Bravo")
        await db.commit()

    async with _TestSession() as db:
        out = describe(await open_shift_for_vehicle(db, v1))
    assert out["crew_name"] == "PyTest Crew Bravo"


# ── Over HTTP, the way the picker asks ───────────────────────────────────────

@pytest.mark.asyncio
async def test_status_endpoint_requires_the_device_unlock(client, fleet):
    """No portal grant, no answer.

    The fleet list itself is already gated for this reason; an occupancy probe
    that was not would leak the same operational data one vehicle at a time,
    and the name of the crew on it with it.
    """
    _, v1, _, _, _ = fleet
    res = await client.get(f"/api/providers/pytest-prf-provider/vehicle-status/{v1}")
    assert res.status_code == 401
    assert res.json().get("in_use") is None


@pytest.mark.asyncio
async def test_status_endpoint_answers_a_grant_holding_device(client, fleet):
    """The real path: free before the claim, named after it."""
    provider, v1, _, crew, _ = fleet
    h = _grant(provider)

    res = await client.get(
        f"/api/providers/pytest-prf-provider/vehicle-status/{v1}", headers=h)
    assert res.status_code == 200
    assert res.json() == {"in_use": False}

    async with _TestSession() as db:
        await claim_vehicle(db, provider_id=provider, crew_member_id=crew,
                            vehicle_id=v1, vehicle_callsign="PYTEST ALPHA 1",
                            crew_name="PyTest Crew Alpha")
        await db.commit()

    res = await client.get(
        f"/api/providers/pytest-prf-provider/vehicle-status/{v1}", headers=h)
    assert res.status_code == 200
    body = res.json()
    assert body["in_use"] is True
    assert body["crew_name"] == "PyTest Crew Alpha"
    assert body["vehicle_callsign"] == "PYTEST ALPHA 1"


@pytest.mark.asyncio
async def test_status_endpoint_rejects_an_unknown_vehicle(client, fleet):
    """A well-formed id belonging to nobody is a 404, not a 'free' answer —
    otherwise the endpoint doubles as a fleet-id oracle."""
    provider, _, _, _, _ = fleet
    res = await client.get(
        f"/api/providers/pytest-prf-provider/vehicle-status/{uuid.uuid4()}",
        headers=_grant(provider),
    )
    assert res.status_code == 404
    assert res.json().get("in_use") is None


@pytest.mark.asyncio
async def test_status_endpoint_rejects_a_malformed_id(client, fleet):
    """The UUIDPath pattern answers 422 instead of a 500 plus a crash-log row."""
    provider, _, _, _, _ = fleet
    res = await client.get(
        "/api/providers/pytest-prf-provider/vehicle-status/not-a-uuid",
        headers=_grant(provider),
    )
    assert res.status_code == 422
