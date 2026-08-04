"""
Data-subject rights and tenant exit — POPIA s23, s24, s14.

Three questions a scheme's officer always asks had no answer in code:
"what do you hold on this member", "how do we get our data back", and "how long
do you keep it". The first two had no route at all; the third had a precise
answer for BACKUPS and none for live records, which is the half that matters.
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

pytestmark = pytest.mark.asyncio

_MARKER = "ZZRIGHTS"

# A unique subject per run. Other suites seed the same well-known SA ID, and a
# subject-access request correctly returns EVERY record for the identifier — so
# a shared ID makes an exact-count assertion meaningless. The isolation property
# being tested (one subject's records never appear in another's SAR) needs the
# subject to genuinely be ours.
_RUN = uuid.uuid4().int
_ID = str(9_000_000_000_000 + _RUN % 900_000_000_000)
_OTHER_ID = str(8_000_000_000_000 + (_RUN >> 8) % 900_000_000_000)


@pytest_asyncio.fixture
async def subject_records():
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        provider = (await db.execute(
            select(ServiceProvider).where(ServiceProvider.slug == "pytest-prf-provider")
        )).scalar_one()
        crew = (await db.execute(
            select(CrewMember).where(CrewMember.email == "crew_a_pytest@emsclaims.test")
        )).scalar_one()
        top = (await db.execute(
            select(DigitalPRF.prf_number).where(DigitalPRF.provider_id == provider.id)
            .order_by(DigitalPRF.prf_number.desc()).limit(1)
        )).scalar() or 0

        # Two records for our subject, one for somebody else.
        db.add(Case(patient_name=f"{_MARKER} Subject", patient_id_number=_ID))
        db.add(Case(patient_name=f"{_MARKER} Stranger", patient_id_number=_OTHER_ID))
        for i, ident in enumerate((_ID, _OTHER_ID)):
            db.add(DigitalPRF(
                provider_id=provider.id, crew_member_1_id=crew.id,
                prf_number=top + 21000 + i,
                case_number=f"{_MARKER}-{uuid.uuid4().hex[:8]}",
                status=PRFStatus.SUBMITTED,
                form_data={"patient_id_number": ident, "chief_complaint": "chest pain"},
            ))
        await db.commit()
        pid = str(provider.id)

    yield pid

    async with _TestSession() as db:
        await db.execute(text("update digital_prfs set case_id=null where case_number like :m"),
                         {"m": f"{_MARKER}%"})
        await db.execute(text("delete from digital_prfs where case_number like :m"),
                         {"m": f"{_MARKER}%"})
        await db.execute(text("delete from cases where patient_name like :m"),
                         {"m": f"%{_MARKER}%"})
        # audit_logs is append-only at the database level (trigger
        # trg_audit_logs_append_only). Cleaning up test rows is legitimate
        # maintenance and must say so explicitly — that visibility is the
        # whole point of the escape hatch.
        await db.execute(text("SET LOCAL ems.audit_maintenance = \'on\'"))
        await db.execute(text(
            "delete from audit_logs where entity_type in "
            "('subject_access','provider_export')"))
        await db.commit()


async def test_subject_access_returns_that_person_and_only_that_person(
    client, auth_headers, subject_records
):
    res = await client.post(
        "/api/data-rights/subject-access", json={"id_number": _ID}, headers=auth_headers,
    )
    assert res.status_code == 200, res.text[:200]
    body = res.json()
    assert body["found"] is True
    assert len(body["cases"]) == 1, f"expected one case, got {len(body['cases'])}"
    assert len(body["patient_report_forms"]) == 1

    blob = res.text
    assert _OTHER_ID not in blob, "another data subject's records leaked into the response"
    assert _ID in blob, "the subject's own ID should be readable in their own SAR"


async def test_formatting_does_not_change_who_is_found(client, auth_headers, subject_records):
    """A lookup that missed on a space would tell a member we hold nothing
    about them.

    The protection lives in normalise_id, which id_hash calls internally — so
    this stays green if the route's own (redundant) normalise call is removed,
    and goes red the moment the real one is. Verified by mutating both.

    The identifier is OUR subject's, spaced into the shape an SA ID is printed
    in. It used to be the literal "900101 5800 083", which this module never
    creates — `_ID` is randomised per run precisely so the subject is ours. The
    test therefore passed only when test_by_case_privilege.py had left its own
    9001015800083 record lying in a shared database, and reported `found: false`
    on the fresh database CI builds. It was measuring the leftovers of another
    module, not normalisation.
    """
    spaced = f"{_ID[:6]} {_ID[6:10]} {_ID[10:]}"
    assert spaced != _ID and spaced.replace(" ", "") == _ID, "the fixture ID is not 13 digits"

    res = await client.post(
        "/api/data-rights/subject-access",
        json={"id_number": spaced}, headers=auth_headers,
    )
    assert res.status_code == 200
    assert res.json()["found"] is True, (
        f"a spaced identifier ({spaced}) found nothing, unspaced finds the subject"
    )


async def test_a_subject_access_request_is_logged_as_a_transmit(
    client, auth_headers, subject_records
):
    """This hands over a person's complete history in one response — if
    anything in the system is audited, it is this."""
    from tests.conftest import _TestSession

    await client.post(
        "/api/data-rights/subject-access", json={"id_number": _ID}, headers=auth_headers,
    )
    async with _TestSession() as db:
        rows = (await db.execute(
            select(AuditLog).where(AuditLog.entity_type == "subject_access")
        )).scalars().all()
    assert len(rows) == 1, "a full subject-access export left no audit trail"
    assert rows[0].action == "TRANSMIT"
    assert _ID not in str(rows[0].details), "the audit row restated the identifier"


async def test_a_provider_can_get_its_own_data_back(client, auth_headers, subject_records):
    """The EMS provider is the responsible party for the records its crews
    create; on termination those records go back before anything is destroyed."""
    provider_id = subject_records
    res = await client.get(
        f"/api/data-rights/provider/{provider_id}/export", headers=auth_headers,
    )
    assert res.status_code == 200, res.text[:200]
    body = res.json()
    assert body["record_counts"]["patient_report_forms"] >= 2

    # OUR records, not [0]. The export orders by prf_number ascending and this
    # provider is shared with every other module in the suite, so [0] is
    # whichever PRF happens to hold the lowest number — in a fresh database that
    # is an empty draft another module created through the API, and asserting on
    # its clinical_record checked nothing about this export. Which module wins
    # the low number decides whether the test passes.
    mine = [p for p in body["patient_report_forms"]
            if (p["case_number"] or "").startswith(_MARKER)]
    assert len(mine) >= 2, f"the fixture's own PRFs are missing from the export ({len(mine)})"
    for prf in mine:
        assert prf["clinical_record"], f"{prf['case_number']} came back empty"
        assert prf["clinical_record"].get("chief_complaint") == "chest pain", (
            "the export returned a record without the clinical content the fixture wrote"
        )


async def test_the_retention_policy_is_reported_not_just_documented(client, auth_headers):
    res = await client.get("/api/data-rights/retention", headers=auth_headers)
    assert res.status_code == 200, res.text[:200]
    body = res.json()
    assert body["policy"]["retention_years"] > 0
    assert "cutoff" in body["policy"]
    assert "due_for_destruction" in body
    assert body["policy"]["enforcement"] == "reporting only", (
        "automatic destruction of clinical records must be opt-in"
    )


@pytest.mark.parametrize("method,route,body", [
    ("POST", "/api/data-rights/subject-access", {"id_number": "9001015800083"}),
    ("GET", "/api/data-rights/retention", None),
])
async def test_data_rights_routes_require_admin(client, method, route, body):
    """These assemble more patient data into one response than anything else."""
    res = (await client.post(route, json=body)) if method == "POST"         else (await client.get(route))
    assert res.status_code in (401, 403), f"{route} was reachable unauthenticated"


async def test_subject_access_is_not_reachable_by_GET(client, auth_headers):
    """The identifier must never travel in a URL — nginx and uvicorn both log
    the query string verbatim, to files with no rotation and no encryption.

    Guards the GET->POST change: if someone reinstates a GET for convenience,
    every subject-access request starts writing an SA ID to disk in cleartext.
    """
    res = await client.get(
        "/api/data-rights/subject-access?id_number=9001015800083", headers=auth_headers,
    )
    assert res.status_code == 405, "subject-access accepted the ID in the URL again"
