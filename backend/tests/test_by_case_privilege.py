"""
The /admin/by-case/* family must require back-office ADMIN, not just a login.

`_resolve_case_prf_access` is the ONLY authorisation on all three by-case
routes — the router is registered bare. Its admin branch ended at "a User row
exists and is_active": no role check, no permission check. `User.role` defaults
to PARAMEDIC and an ADMIN can mint any role, so the lowest-privilege account on
the instance could:

  • read every provider's complete clinical record — form_data, SA ID number,
    all five signatures, both crew members' names and HPCSA numbers — by
    enumerating case ids through GET /api/cases/, which was itself
    authentication-only and instance-wide;
  • mail a patient's full PRF to any address, sent FROM the owning provider's
    own mailbox using its decrypted SMTP app password;
  • stamp facility_email_sent_at via the /manual route, which every downstream
    guard honours — so the receiving hospital never gets the handover document
    while the crew UI, the admin surfaces and the database all record it as
    delivered.

failed_prfs.py already carries a router-level require_role + require_permission
for exactly this shape of defect. That fix never reached this family.
"""
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from app.models.case import Case
from app.models.crew_member import CrewMember
from app.models.digital_prf import DigitalPRF, PRFStatus
from app.models.service_provider import ServiceProvider
from app.models.user import User, UserRole
from app.utils.security import hash_password

pytestmark = pytest.mark.asyncio

_PASSWORD = "ByCaseFixture!2026"
_MARKER = "ZZBYCASE"

# Every role that is NOT back-office admin. Each must be refused.
_NON_ADMIN_ROLES = [
    UserRole.PARAMEDIC,     # the model default — what a carelessly-created user gets
    UserRole.DISPATCHER,
    UserRole.BILLING_CLERK,
]


async def _user_with(email: str, role: UserRole) -> str:
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        user = (await db.execute(
            select(User).where(User.email == email)
        )).scalar_one_or_none()
        if user is None:
            user = User(
                email=email,
                hashed_password=hash_password(_PASSWORD),
                full_name="By-Case Fixture",
                bhf_practice_number="0000000",
            )
            db.add(user)
        user.role = role
        user.permissions = None      # NULL = "all" — the fail-open case
        user.is_active = True
        await db.commit()
    return email


async def _login(client, email: str) -> dict:
    resp = await client.post(
        "/api/auth/login", data={"username": email, "password": _PASSWORD}
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


@pytest_asyncio.fixture
async def submitted_case():
    """A submitted PRF with a Case — the shape the PDF viewer resolves."""
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
            .order_by(DigitalPRF.prf_number.desc())
            .limit(1)
        )).scalar() or 0

        case = Case(patient_name=f"{_MARKER} Patient", medical_scheme_name="PyTest")
        db.add(case)
        await db.flush()

        prf = DigitalPRF(
            provider_id=provider.id,
            crew_member_1_id=crew.id,
            case_id=case.id,
            prf_number=highest + 5000,
            case_number=f"{_MARKER}-{uuid.uuid4().hex[:10]}",
            status=PRFStatus.SUBMITTED,
            form_data={"patient_name": _MARKER, "patient_id_number": "9001015800083"},
        )
        db.add(prf)
        await db.commit()
        case_id = str(case.id)

    yield case_id

    async with _TestSession() as db:
        await db.execute(
            text("update digital_prfs set case_id = null where case_number like :m"),
            {"m": f"{_MARKER}%"},
        )
        await db.execute(
            text("delete from digital_prfs where case_number like :m"),
            {"m": f"{_MARKER}%"},
        )
        await db.execute(
            text("delete from cases where patient_name like :m"), {"m": f"%{_MARKER}%"}
        )
        await db.commit()


@pytest.mark.parametrize("role", _NON_ADMIN_ROLES, ids=lambda r: r.value)
async def test_non_admin_cannot_read_a_patient_record(client, submitted_case, role):
    email = await _user_with(f"bycase_{role.value}@emsclaims.test", role)
    headers = await _login(client, email)

    res = await client.get(
        f"/api/digital-prf/admin/by-case/{submitted_case}", headers=headers
    )
    assert res.status_code == 403, (
        f"a {role.value} account read a full clinical record: {res.status_code} "
        f"{res.text[:300]}"
    )
    assert _MARKER not in res.text, "patient data leaked in the refusal body"


@pytest.mark.parametrize("role", _NON_ADMIN_ROLES, ids=lambda r: r.value)
async def test_non_admin_cannot_send_a_patient_record_by_email(
    client, submitted_case, role
):
    """The worst of the three: outbound PHI from the tenant's own mailbox."""
    email = await _user_with(f"bycase_{role.value}@emsclaims.test", role)
    headers = await _login(client, email)

    res = await client.post(
        f"/api/digital-prf/admin/by-case/{submitted_case}/email-facility",
        headers=headers,
        data={"recipient": "attacker@example.com"},
        files={"file": ("prf.pdf", b"%PDF-1.4 fake", "application/pdf")},
    )
    assert res.status_code == 403, (
        f"a {role.value} account could mail a patient PRF to an arbitrary "
        f"address: {res.status_code} {res.text[:300]}"
    )


@pytest.mark.parametrize("role", _NON_ADMIN_ROLES, ids=lambda r: r.value)
async def test_non_admin_cannot_suppress_the_hospital_handover(
    client, submitted_case, role
):
    """Marking 'sent manually' stops every later send. If the hospital never
    received it, the record says otherwise and nobody notices."""
    email = await _user_with(f"bycase_{role.value}@emsclaims.test", role)
    headers = await _login(client, email)

    res = await client.post(
        f"/api/digital-prf/admin/by-case/{submitted_case}/email-facility/manual",
        headers=headers,
        json={"recipient": "nobody@example.com"},
    )
    assert res.status_code == 403, (
        f"a {role.value} account suppressed a clinical handover: "
        f"{res.status_code} {res.text[:300]}"
    )


@pytest.mark.parametrize("role", _NON_ADMIN_ROLES, ids=lambda r: r.value)
async def test_non_admin_cannot_enumerate_the_case_list(client, role):
    """The enumeration step. Case ids are what make the read above reachable."""
    email = await _user_with(f"bycase_{role.value}@emsclaims.test", role)
    headers = await _login(client, email)

    res = await client.get("/api/cases/", headers=headers)
    assert res.status_code == 403, (
        f"a {role.value} account listed every provider's cases: {res.status_code}"
    )


async def test_an_admin_can_still_do_all_three(client, auth_headers, submitted_case):
    """The gate must not break the people who are supposed to be here.

    Without this, refusing everybody would pass every test above.
    """
    read = await client.get(
        f"/api/digital-prf/admin/by-case/{submitted_case}", headers=auth_headers
    )
    assert read.status_code == 200, read.text[:300]
    assert read.json().get("prf_number"), "admin read returned no PRF"

    listed = await client.get("/api/cases/", headers=auth_headers)
    assert listed.status_code == 200, listed.text[:300]

    marked = await client.post(
        f"/api/digital-prf/admin/by-case/{submitted_case}/email-facility/manual",
        headers=auth_headers,
        json={"recipient": "doctor@hospital.co.za"},
    )
    assert marked.status_code == 200, marked.text[:300]


async def test_manual_mark_rejects_a_bogus_recipient(client, auth_headers, submitted_case):
    """facility_email_sent_to is the only record of where a handover went, and
    stamping it suppresses every later send. Free text made that unauditable."""
    res = await client.post(
        f"/api/digital-prf/admin/by-case/{submitted_case}/email-facility/manual",
        headers=auth_headers,
        json={"recipient": "definitely not an email"},
    )
    assert res.status_code == 400, res.text[:300]


async def test_malformed_case_id_is_a_400_not_a_500(client, auth_headers):
    """A bare uuid.UUID() raised ValueError -> 500 + a logged stack trace."""
    res = await client.get(
        "/api/digital-prf/admin/by-case/not-a-uuid", headers=auth_headers
    )
    assert res.status_code == 400, res.text[:300]


async def test_the_owning_crew_can_still_read_their_own_prf(client, submitted_case):
    """The crew branch is a separate path and must be untouched by the role gate
    — crews hold a crew token, never a User role."""
    from tests.conftest import _TestSession
    from app.utils.security import create_access_token

    async with _TestSession() as db:
        crew = (await db.execute(
            select(CrewMember).where(CrewMember.email == "crew_a_pytest@emsclaims.test")
        )).scalar_one()
        # Same claim shape crew_auth.py mints on login.
        token = create_access_token({
            "sub": str(crew.id),
            "crew_id": str(crew.id),
            "provider_id": str(crew.provider_id),
            "role": crew.role,
            "token_scope": "crew",
        })

    res = await client.get(
        f"/api/digital-prf/admin/by-case/{submitted_case}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, (
        f"the crew member who captured this PRF can no longer read it: "
        f"{res.status_code} {res.text[:300]}"
    )
