"""
One ambulance call must produce exactly one claim.

The billing pipeline's per-row guard (SELECT ... FOR UPDATE plus a case_id
check) is correct for the SAME row. These are the four ways a second row, or a
stale-state row, walked straight past it:

  1. The task's guard was a deny-list of two conditions, so CORRECTED and DRAFT
     fell through and were billed.
  2. correct_failed_prf checked status but never case_id, so a FAILED-but-billed
     PRF could be corrected into a second Case + Claim.
  3. _mark_failed stamped FAILED without re-reading, so it could label an
     already-billed PRF as failed — which is what puts it in the queue where (2)
     is the only action offered.
  4. The watchdog escalated from a stale batch snapshot, same effect as (3).

Every one of them ends in the scheme being billed twice for one incident.
"""
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from app.models.case import Case
from app.models.crew_member import CrewMember
from app.models.digital_prf import DigitalPRF, PRFStatus
from app.models.service_provider import ServiceProvider

pytestmark = pytest.mark.asyncio

_MARKER = "ZZBILLING"


@pytest_asyncio.fixture
async def billing_fixture():
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        provider = (await db.execute(
            select(ServiceProvider).where(ServiceProvider.slug == "pytest-prf-provider")
        )).scalar_one()
        crew = (await db.execute(
            select(CrewMember).where(CrewMember.email == "crew_a_pytest@emsclaims.test")
        )).scalar_one()
        highest = (await db.execute(
            select(DigitalPRF.prf_number)
            .where(DigitalPRF.provider_id == provider.id)
            .order_by(DigitalPRF.prf_number.desc()).limit(1)
        )).scalar() or 0
        yield provider, crew, highest + 7000

    async with _TestSession() as db:
        ids = (await db.execute(
            select(DigitalPRF.case_id).where(DigitalPRF.case_number.like(f"{_MARKER}%"))
        )).scalars().all()
        ids = [i for i in ids if i]
        await db.execute(
            text("update digital_prfs set case_id=null, document_id=null, correction_of_id=null "
                 "where case_number like :m"), {"m": f"{_MARKER}%"})
        await db.execute(text("delete from digital_prfs where case_number like :m"),
                         {"m": f"{_MARKER}%"})
        if ids:
            await db.execute(text("delete from claim_lines where claim_id in "
                                  "(select id from claims where case_id = any(:ids))"), {"ids": ids})
            await db.execute(text("delete from claims where case_id = any(:ids)"), {"ids": ids})
            await db.execute(text("delete from documents where case_id = any(:ids)"), {"ids": ids})
            await db.execute(text("delete from cases where id = any(:ids)"), {"ids": ids})
        await db.commit()


async def _prf(db, provider, crew, number, *, status, case_id=None, correction_of=None):
    row = DigitalPRF(
        provider_id=provider.id,
        crew_member_1_id=crew.id,
        prf_number=number,
        case_number=f"{_MARKER}-{uuid.uuid4().hex[:10]}",
        status=status,
        case_id=case_id,
        correction_of_id=correction_of,
        form_data={"patient_name": _MARKER, "call_type": "PRIMARY"},
    )
    db.add(row)
    await db.flush()
    return row


async def _case(db):
    c = Case(patient_name=f"{_MARKER} Patient", medical_scheme_name="PyTest")
    db.add(c)
    await db.flush()
    return c


# ── 1. The task's guard ─────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "status", [PRFStatus.CORRECTED, PRFStatus.DRAFT, PRFStatus.PROCESSED],
    ids=lambda s: s.value,
)
async def test_billing_task_refuses_a_non_billable_status(billing_fixture, status):
    """CORRECTED means a replacement row owns this incident. DRAFT means no crew
    ever successfully submitted it (the submit endpoint reverts to DRAFT when the
    enqueue fails). Neither may be billed."""
    from tests.conftest import _TestSession
    from tests.test_case_capture_order import _run_billing_task

    provider, crew, base = billing_fixture
    async with _TestSession() as db:
        prf = await _prf(db, provider, crew, base + 1, status=status)
        await db.commit()
        prf_id = prf.id

    result = await _run_billing_task(prf_id)
    assert result.get("status") == "skipped", (
        f"a {status.value} PRF was processed into a Case: {result}"
    )

    async with _TestSession() as db:
        after = (await db.execute(
            select(DigitalPRF).where(DigitalPRF.id == prf_id)
        )).scalar_one()
        assert after.case_id is None, "a non-billable PRF was given a Case"
        assert after.status == status, (
            f"status was overwritten {status.value} -> {after.status.value}; for "
            f"CORRECTED that destroys the lineage record the correction keeps"
        )


# ── 2. Correcting an already-billed PRF ─────────────────────────────────────

async def test_correcting_an_already_billed_prf_is_refused(
    client, auth_headers, billing_fixture
):
    from tests.conftest import _TestSession

    provider, crew, base = billing_fixture
    async with _TestSession() as db:
        case = await _case(db)
        prf = await _prf(db, provider, crew, base + 2, status=PRFStatus.FAILED, case_id=case.id)
        await db.commit()
        prf_id, before_case = str(prf.id), case.id

    res = await client.put(
        f"/api/failed-prfs/{prf_id}/correct",
        headers=auth_headers,
        json={"form_data": {"patient_name": "Corrected"}},
    )
    assert res.status_code == 409, (
        f"correcting a billed PRF was allowed — that raises a second claim for "
        f"one call: {res.status_code} {res.text[:200]}"
    )

    async with _TestSession() as db:
        replacements = (await db.execute(
            select(DigitalPRF).where(DigitalPRF.correction_of_id == uuid.UUID(prf_id))
        )).scalars().all()
        assert replacements == [], "a correction row was created anyway"
        still = (await db.execute(
            select(DigitalPRF).where(DigitalPRF.id == uuid.UUID(prf_id))
        )).scalar_one()
        assert still.case_id == before_case


# ── 3. _mark_failed must not label a billed PRF as failed ───────────────────

async def test_mark_failed_leaves_an_already_billed_prf_alone(billing_fixture):
    from tests.conftest import _TestSession
    from app.tasks.prf_processing import _mark_failed

    provider, crew, base = billing_fixture
    async with _TestSession() as db:
        case = await _case(db)
        prf = await _prf(db, provider, crew, base + 3, status=PRFStatus.PROCESSED, case_id=case.id)
        await db.commit()
        prf_id = prf.id

    await _mark_failed(str(prf_id), "something raised after the Case was written")

    async with _TestSession() as db:
        after = (await db.execute(
            select(DigitalPRF).where(DigitalPRF.id == prf_id)
        )).scalar_one()
        assert after.status != PRFStatus.FAILED, (
            "a billed PRF was marked FAILED — it then appears in the failed queue "
            "where Retry is refused and Correct raises a duplicate claim"
        )
        assert after.processing_error, "the error should still be recorded"


# ── 4. A correction must carry the signatures ──────────────────────────────

async def test_a_correction_carries_the_signatures(client, auth_headers, billing_fixture):
    """handover_signature is the receiving facility's proof of delivery, and the
    corrected row is the one that gets billed and rendered into the PDF."""
    from tests.conftest import _TestSession

    provider, crew, base = billing_fixture
    async with _TestSession() as db:
        prf = await _prf(db, provider, crew, base + 4, status=PRFStatus.FAILED)
        prf.patient_signature = "data:image/png;base64,PATIENTSIG"
        prf.handover_signature = "data:image/png;base64,HANDOVERSIG"
        prf.crew_signature = "data:image/png;base64,CREWSIG"
        prf.witness_signature = "data:image/png;base64,WITNESSSIG"
        prf.valuables_signature = "data:image/png;base64,VALUABLESSIG"
        await db.commit()
        prf_id = str(prf.id)

    res = await client.put(
        f"/api/failed-prfs/{prf_id}/correct",
        headers=auth_headers,
        json={"form_data": {"patient_name": "Corrected"}},
    )
    assert res.status_code == 200, res.text[:300]

    async with _TestSession() as db:
        corrected = (await db.execute(
            select(DigitalPRF).where(DigitalPRF.correction_of_id == uuid.UUID(prf_id))
        )).scalar_one()
        for field in (
            "patient_signature", "handover_signature", "crew_signature",
            "witness_signature", "valuables_signature",
        ):
            assert getattr(corrected, field), (
                f"{field} was dropped by the correction — the billed record and "
                f"the PDF sent to the hospital would have no such signature"
            )
        # And the billing artefacts of the ORIGINAL must NOT be inherited.
        assert corrected.case_id is None
        assert corrected.document_id is None
        assert corrected.facility_email_sent_at is None
