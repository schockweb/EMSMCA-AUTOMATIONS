"""
Every read of a patient record must leave a trace.

Nothing in this platform has ever logged a READ. `audit_logs` recorded logins,
corrections and claim edits, but not one row saying a person opened a patient's
clinical record — `log_action` accepts action="READ" and no caller ever passed
it.

That is a legal problem, not a nice-to-have. POPIA s22 requires notifying the
Information Regulator AND every affected data subject when personal information
may have been accessed by an unauthorised person. Answering "which patients?"
needs a read trail; without one the only honest answer is "we cannot tell", and
a contained incident has to be reported as an instance-wide disclosure.
"""
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from app.models.audit_log import AuditLog
from app.models.case import Case
from app.models.crew_member import CrewMember
from app.models.digital_prf import DigitalPRF, PRFStatus
from app.models.service_provider import ServiceProvider
from app.utils.security import create_access_token

pytestmark = pytest.mark.asyncio

_MARKER = "ZZAUDIT"


@pytest_asyncio.fixture
async def audited_prf():
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        provider = (await db.execute(
            select(ServiceProvider).where(ServiceProvider.slug == "pytest-prf-provider")
        )).scalar_one()
        crew = (await db.execute(
            select(CrewMember).where(CrewMember.email == "crew_a_pytest@emsclaims.test")
        )).scalar_one()
        highest = (await db.execute(
            select(DigitalPRF.prf_number).where(DigitalPRF.provider_id == provider.id)
            .order_by(DigitalPRF.prf_number.desc()).limit(1)
        )).scalar() or 0

        case = Case(patient_name=f"{_MARKER} Patient", medical_scheme_name="PyTest")
        db.add(case)
        await db.flush()
        prf = DigitalPRF(
            provider_id=provider.id, crew_member_1_id=crew.id, case_id=case.id,
            prf_number=highest + 9000,
            case_number=f"{_MARKER}-{uuid.uuid4().hex[:10]}",
            status=PRFStatus.SUBMITTED,
            form_data={"patient_name": _MARKER},
        )
        db.add(prf)
        await db.commit()
        ids = (str(prf.id), str(case.id), crew)

    # Clear any audit rows for this PRF so counts start from zero.
    async with _TestSession() as db:
        await db.execute(text("delete from audit_logs where entity_id = :e"),
                         {"e": ids[0]})
        await db.commit()

    yield ids

    async with _TestSession() as db:
        await db.execute(text("delete from audit_logs where entity_id in (:p, :c)"),
                         {"p": ids[0], "c": ids[1]})
        await db.execute(text("update digital_prfs set case_id=null where case_number like :m"),
                         {"m": f"{_MARKER}%"})
        await db.execute(text("delete from digital_prfs where case_number like :m"),
                         {"m": f"{_MARKER}%"})
        await db.execute(text("delete from cases where patient_name like :m"),
                         {"m": f"%{_MARKER}%"})
        await db.commit()


async def _entries(entity_id: str, action: str | None = None) -> list[AuditLog]:
    from tests.conftest import _TestSession
    async with _TestSession() as db:
        q = select(AuditLog).where(AuditLog.entity_id == uuid.UUID(entity_id))
        if action:
            q = q.where(AuditLog.action == action)
        return (await db.execute(q)).scalars().all()


def _crew_token(crew) -> str:
    return create_access_token({
        "sub": str(crew.id), "crew_id": str(crew.id),
        "provider_id": str(crew.provider_id), "role": crew.role,
        "token_scope": "crew",
    })


async def test_admin_opening_a_patient_record_is_recorded(
    client, auth_headers, audited_prf
):
    prf_id, case_id, _crew = audited_prf

    res = await client.get(f"/api/digital-prf/admin/by-case/{case_id}", headers=auth_headers)
    assert res.status_code == 200, res.text[:200]

    rows = await _entries(prf_id, "READ")
    assert len(rows) == 1, f"the PDF viewer read a full clinical record unlogged: {rows}"
    row = rows[0]
    assert row.user_id is not None, "the acting back-office user was not identified"
    assert row.details.get("actor_type") == "back_office"
    assert row.ip_address, "no source address recorded"


async def test_a_crew_member_reading_their_own_prf_is_recorded(client, audited_prf):
    """Crew are not users. Without the crew_member_id column the majority of
    clinical reads would have no identifiable actor at all."""
    prf_id, _case_id, crew = audited_prf
    headers = {"Authorization": f"Bearer {_crew_token(crew)}"}

    res = await client.get(f"/api/digital-prf/{prf_id}", headers=headers)
    assert res.status_code == 200, res.text[:200]

    rows = await _entries(prf_id, "READ")
    assert len(rows) >= 1, "a crew member opened a patient record unlogged"
    assert any(r.crew_member_id == crew.id for r in rows), (
        f"the crew member was not named on the audit row: "
        f"{[(r.user_id, r.crew_member_id) for r in rows]}"
    )


async def test_sending_a_record_to_a_hospital_is_logged_as_transmit(
    client, auth_headers, audited_prf
):
    """PHI leaving the platform is a materially different event from viewing it,
    and an incident review has to be able to ask for it separately."""
    prf_id, case_id, _crew = audited_prf

    await client.post(
        f"/api/digital-prf/admin/by-case/{case_id}/email-facility/manual",
        headers=auth_headers, json={"recipient": "doctor@hospital.co.za"},
    )

    transmits = await _entries(prf_id, "TRANSMIT")
    assert len(transmits) == 1, (
        f"a PRF was released to a third party and recorded as {[r.action for r in await _entries(prf_id)]}"
    )


async def test_a_refused_read_is_not_recorded_as_an_access(client, audited_prf):
    """The log must describe what happened, not what was attempted. A 403 that
    appears as a READ would inflate the scope of every future investigation."""
    prf_id, case_id, _crew = audited_prf

    res = await client.get(f"/api/digital-prf/admin/by-case/{case_id}")   # no token
    assert res.status_code == 401

    assert await _entries(prf_id, "READ") == [], "a refused request was logged as a read"


async def test_the_log_holds_no_patient_data(client, auth_headers, audited_prf):
    """The audit trail records WHICH record was read, never its contents.

    Copying patient data here would create a second, longer-lived store of the
    same PHI — needing its own access control, retention rule and breach
    analysis. An audit log that leaks is worse than no audit log.
    """
    prf_id, case_id, _crew = audited_prf
    await client.get(f"/api/digital-prf/admin/by-case/{case_id}", headers=auth_headers)

    for row in await _entries(prf_id):
        blob = f"{row.details} {row.notes} {row.before_state} {row.after_state}"
        assert _MARKER not in blob, (
            f"the patient's name was copied into the audit log: {blob[:200]}"
        )


async def test_a_logging_failure_never_denies_a_clinical_read(
    client, auth_headers, audited_prf, monkeypatch
):
    """A paramedic must still get the record in front of them if the audit
    insert fails. The harm from a blocked read at a roadside is immediate and
    physical; a missing audit row is neither."""
    import app.services.phi_audit as mod
    prf_id, case_id, _crew = audited_prf

    # Break the write INSIDE record_phi_access — the resilience lives in that
    # function, so replacing the function itself would test the monkeypatch
    # rather than the code. (First attempt at this test did exactly that and
    # "failed" against a correct implementation.)
    def _explode(*a, **k):
        raise RuntimeError("audit table unavailable")

    monkeypatch.setattr(mod, "AuditLog", _explode)

    res = await client.get(f"/api/digital-prf/admin/by-case/{case_id}", headers=auth_headers)
    assert res.status_code == 200, (
        f"a failing audit log blocked a clinical read: {res.status_code} {res.text[:200]}"
    )
    assert await _entries(prf_id, "READ") == [], "sanity: the write really did fail"


# ─────────────────────────────────────────────────────────────────────────────
# Holes an adversarial review found in the first version of this logging.
# ─────────────────────────────────────────────────────────────────────────────

async def test_listing_cases_is_logged_as_an_access(client, auth_headers, audited_prf):
    """The bigger disclosure was the one NOT logged.

    Only the case DETAIL route was recorded. The LIST response carries up to 200
    patients' names AND their decrypted SA ID numbers, so paging it harvests far
    more than opening records one at a time — and left no trace at all.
    """
    from tests.conftest import _TestSession

    before = await _entries_by_type("case_list")
    res = await client.get("/api/cases/", params={"limit": 5}, headers=auth_headers)
    assert res.status_code == 200, res.text[:200]
    after = await _entries_by_type("case_list")

    assert len(after) == len(before) + 1, (
        "listing patient records wrote no audit row — the largest single "
        "disclosure in the product would be invisible"
    )
    assert after[-1].details.get("returned") is not None, (
        "the row does not record how many patients were disclosed, which is "
        "what bounds the exposure"
    )


async def test_a_cached_prf_read_is_still_logged(client, audited_prf):
    """Submitted PRFs are Redis-cached for CACHE_TTL_PRF_SUBMITTED_SECONDS —
    one HOUR. The audit call sat below the cache's early return, so an hour of
    re-reads recorded a single access."""
    from tests.conftest import _TestSession
    from app.utils.security import create_access_token

    prf_id, _case_id, crew = audited_prf
    token = create_access_token({
        "sub": str(crew.id), "crew_id": str(crew.id),
        "provider_id": str(crew.provider_id), "role": crew.role,
        "token_scope": "crew",
    })
    headers = {"Authorization": f"Bearer {token}"}

    for _ in range(3):
        r = await client.get(f"/api/digital-prf/{prf_id}", headers=headers)
        assert r.status_code == 200, r.text[:200]

    rows = await _entries(prf_id, "READ")
    assert len(rows) >= 3, (
        f"three reads produced {len(rows)} audit row(s) — a cache hit is still "
        f"a person looking at a patient's record"
    )


async def _entries_by_type(entity_type: str):
    from tests.conftest import _TestSession
    async with _TestSession() as db:
        return (await db.execute(
            select(AuditLog).where(AuditLog.entity_type == entity_type)
            .order_by(AuditLog.created_at.asc())
        )).scalars().all()


# ─────────────────────────────────────────────────────────────────────────────
# Edits and deletions — the half an investigator actually needs.
# ─────────────────────────────────────────────────────────────────────────────

async def test_editing_a_case_records_before_and_after(client, auth_headers, audited_prf):
    """This route silently rewrote the derived clinical record — patient name,
    ID number, scheme, incident date — with nothing recorded anywhere. Without a
    before/after, "it has not been altered" is an assertion, not evidence."""
    _prf_id, case_id, _crew = audited_prf

    res = await client.patch(
        f"/api/cases/{case_id}", headers=auth_headers,
        json={"patient_name": "Renamed By Admin"},
    )
    assert res.status_code == 200, res.text[:200]

    rows = await _entries(case_id, "UPDATE")
    assert len(rows) == 1, f"a case was edited with no audit row: {rows}"
    row = rows[0]
    assert row.before_state and row.after_state, "no before/after captured"
    assert "patient_name" in row.before_state
    assert row.after_state["patient_name"] == "Renamed By Admin"
    assert row.user_id is not None, "the editing account was not identified"


async def test_an_unchanged_edit_writes_no_row(client, auth_headers, audited_prf):
    """Only fields that actually differ are stored, so a routine no-op save does
    not bury the edit that matters."""
    _prf_id, case_id, _crew = audited_prf

    current = (await client.get(f"/api/cases/{case_id}", headers=auth_headers)).json()
    await client.patch(
        f"/api/cases/{case_id}", headers=auth_headers,
        json={"patient_name": current["patient_name"]},
    )
    assert await _entries(case_id, "UPDATE") == [], "a no-op edit was logged as a change"


async def test_the_audit_snapshot_does_not_copy_the_id_number(
    client, auth_headers, audited_prf
):
    """A deletion snapshot must not become a second, longer-lived copy of the
    identifier we just went to the trouble of encrypting."""
    from tests.conftest import _TestSession
    _prf_id, case_id, _crew = audited_prf

    async with _TestSession() as db:
        case = (await db.execute(
            select(Case).where(Case.id == uuid.UUID(case_id))
        )).scalar_one()
        case.patient_id_number = "9001015800083"
        await db.commit()

    # Change the ID ITSELF, so it is genuinely in the diff. A first version of
    # this test only changed patient_name — the ID never entered before/after
    # either way, so it passed with the redaction removed. That is the fifth
    # vacuous negative assertion caught in this codebase; the shape is always
    # the same, an assertion about data the code path never produced.
    res = await client.patch(
        f"/api/cases/{case_id}", headers=auth_headers,
        json={"patient_id_number": "8202025800086"},
    )
    assert res.status_code == 200, res.text[:200]

    rows = await _entries(case_id, "UPDATE")
    assert rows, "changing the ID number produced no audit row at all"
    captured = " ".join(f"{r.before_state} {r.after_state}" for r in rows)
    assert "patient_id_number" in captured, (
        "the change to the identifier was not recorded as having happened"
    )
    for raw in ("9001015800083", "8202025800086"):
        assert raw not in captured, (
            f"an SA ID number was copied verbatim into the audit log — that is "
            f"a second, longer-lived store of the identifier we just encrypted: "
            f"{captured[:200]}"
        )
