"""
The case list must follow the order calls were CAPTURED, not the order the
billing worker happened to write the rows.

Reported from the field after an offline shift: two PRFs captured back to back,
#129 then #130, appeared in the admin list as #129 above #130 — reading, to the
office, as though the numbering had run backwards ("the next number should be
higher but it's one lower"). Nothing was mis-numbered. The list is ordered by
`Case.created_at`, which defaulted to the moment the Celery billing task
inserted the row, and for an offline PRF that is whenever its outbox entry
happened to drain. The production rows behind the report:

    prf  prf.created_at   submitted_at     case.created_at
    129  13:38:53         13:41:54         13:41:54
    130  13:41:28         13:41:28         13:41:28

#129 was captured first but synced last — its submit needed a retry while
#130's went through on the first pass — so it sorted to the top.

The fix is upstream of the query: the billing task copies the PRF's own
`created_at` onto the Case. Ordering therefore stays on an indexed column
(ordering by a correlated subquery over digital_prfs instead measured 460ms vs
0.03ms at 200k cases, and grows linearly).

The task is driven for real here rather than asserting on a helper — a helper
that returns the right timestamp is worth nothing if the Case does not get it.
"""
import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import func, select, text

from app.models.case import Case
from app.models.crew_member import CrewMember
from app.models.digital_prf import DigitalPRF, PRFStatus
from app.models.service_provider import ServiceProvider

pytestmark = pytest.mark.asyncio

_MARKER_PREFIX = "ZZCAPTURE"


@pytest_asyncio.fixture
async def order_fixture():
    """A unique patient-name marker per run so the search filter isolates these
    rows, plus a PRF-number base above anything the provider already holds
    (`(provider_id, prf_number)` is UNIQUE, and a run that failed to clean up
    would otherwise poison every later run)."""
    from tests.conftest import _TestSession

    marker = f"{_MARKER_PREFIX}{uuid.uuid4().hex[:10].upper()}"

    async with _TestSession() as db:
        provider = (await db.execute(
            select(ServiceProvider).where(ServiceProvider.slug == "pytest-prf-provider")
        )).scalar_one()
        crew = (await db.execute(
            select(CrewMember).where(CrewMember.email == "crew_a_pytest@emsclaims.test")
        )).scalar_one()
        highest = (await db.execute(
            select(func.max(DigitalPRF.prf_number)).where(
                DigitalPRF.provider_id == provider.id
            )
        )).scalar() or 0
        yield marker, provider, crew, highest + 1000

    # Cleanup. Raw SQL in dependency order: the ORM's default cascade tries to
    # NULL out claims.case_id, which is NOT NULL, so letting it manage this
    # fails the teardown.
    async with _TestSession() as db:
        ids = (await db.execute(
            select(Case.id).where(Case.patient_name.like(f"%{marker}%"))
        )).scalars().all()
        params = {"ids": ids, "marker": f"{marker}%"}
        if ids:
            await db.execute(text(
                "delete from claim_lines where claim_id in "
                "(select id from claims where case_id = any(:ids))"
            ), params)
            await db.execute(text("delete from claims where case_id = any(:ids)"), params)
            await db.execute(text(
                "update digital_prfs set case_id = null, document_id = null "
                "where case_id = any(:ids)"
            ), params)
            await db.execute(text("delete from documents where case_id = any(:ids)"), params)
        await db.execute(text("delete from digital_prfs where case_number like :marker"), params)
        if ids:
            await db.execute(text("delete from cases where id = any(:ids)"), params)
        await db.commit()


async def _make_submitted_prf(
    db, marker: str, provider, crew, number: int, captured_at: datetime
) -> uuid.UUID:
    """A PRF sitting in the state the billing task picks up: SUBMITTED, with
    `created_at` set to when the crew actually started the call."""
    prf = DigitalPRF(
        provider_id=provider.id,
        crew_member_1_id=crew.id,
        prf_number=number,
        case_number=f"{marker}-{number}",
        status=PRFStatus.SUBMITTED,
        created_at=captured_at,
        form_data={
            "patient_name": marker,
            "patient_surname": f"N{number}",
            "call_type": "PRIMARY",
        },
    )
    db.add(prf)
    await db.flush()
    return prf.id


async def _run_billing_task(prf_id: uuid.UUID):
    """Run the real Celery task.

    In its own THREAD: the task calls `asyncio.new_event_loop()` +
    `run_until_complete`, which cannot nest inside the loop this async test is
    already running on.
    """
    from app.tasks.prf_processing import process_prf_submission

    def _run():
        return process_prf_submission.apply(args=[str(prf_id)]).get()

    return await asyncio.to_thread(_run)


async def test_the_billing_task_stamps_the_case_with_the_capture_time(order_fixture):
    """A Case must carry when the CALL happened, not when the worker ran."""
    from tests.conftest import _TestSession

    marker, provider, crew, base = order_fixture
    captured_at = datetime.now(timezone.utc) - timedelta(days=3)

    async with _TestSession() as db:
        prf_id = await _make_submitted_prf(
            db, marker, provider, crew, base + 1, captured_at
        )
        await db.commit()

    await _run_billing_task(prf_id)

    async with _TestSession() as db:
        prf = (await db.execute(
            select(DigitalPRF).where(DigitalPRF.id == prf_id)
        )).scalar_one()
        assert prf.case_id is not None, "the task did not produce a Case"
        case = (await db.execute(
            select(Case).where(Case.id == prf.case_id)
        )).scalar_one()

    # Exactly the PRF's own timestamp — days old, not "a moment ago".
    assert case.created_at == captured_at, (
        f"Case timestamped {case.created_at}, expected the capture time {captured_at}"
    )
    assert datetime.now(timezone.utc) - case.created_at > timedelta(days=2), (
        "the Case took the worker's clock instead of the call's"
    )


async def test_a_late_syncing_prf_does_not_jump_the_list(
    client, auth_headers, order_fixture
):
    """The reported failure, end to end.

    Two calls captured back to back offline. The SECOND one syncs first — its
    submit went straight through while the first one's needed a retry — so the
    billing task processes them out of capture order. The list must still read
    highest number at the top.
    """
    from tests.conftest import _TestSession

    marker, provider, crew, base = order_fixture
    first_capture = datetime.now(timezone.utc) - timedelta(days=2, minutes=3)
    second_capture = first_capture + timedelta(minutes=2)

    async with _TestSession() as db:
        early_id = await _make_submitted_prf(
            db, marker, provider, crew, base + 129, first_capture
        )
        late_id = await _make_submitted_prf(
            db, marker, provider, crew, base + 130, second_capture
        )
        await db.commit()

    # Out of order on purpose: #130 is processed BEFORE #129.
    await _run_billing_task(late_id)
    await _run_billing_task(early_id)

    res = await client.get(
        "/api/cases/", params={"search": marker, "limit": 50}, headers=auth_headers
    )
    assert res.status_code == 200, res.text
    listed = res.json()
    assert len(listed) == 2, f"expected this test's two cases, got {len(listed)}"

    names = [c["display_name"] or c["patient_name"] for c in listed]
    assert str(base + 130) in names[0], (
        f"#{base + 130} was captured last and must lead the list; got {names}"
    )
    assert str(base + 129) in names[1], names
