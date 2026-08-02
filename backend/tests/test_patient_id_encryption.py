"""
The SA ID number must be unreadable at rest and unchanged in the application.

An SA ID number encodes date of birth, sex and citizenship, and it is the key
South African institutions use to bind a record to a person. It is the single
most consequential field in this database, and it was stored in plaintext —
`cases.patient_id_number` was String(13), exactly the length of an ID and far
too small for a Fernet token, so there was nowhere to put ciphertext even had
the write path encrypted it. It did not.

These tests assert the two halves that matter:
  * what reaches the DISK is ciphertext (checked with raw SQL, underneath the
    ORM — checking through the ORM would only prove the ORM is self-consistent);
  * what the APPLICATION sees is unchanged, so the eighteen modules that read
    this field keep working.
"""
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from app.models.case import Case
from app.models.crew_member import CrewMember
from app.models.digital_prf import DigitalPRF, PRFStatus
from app.models.service_provider import ServiceProvider
from app.utils.patient_id import decrypt_id, encrypt_id, id_hash, looks_encrypted, normalise_id

pytestmark = pytest.mark.asyncio

_MARKER = "ZZCRYPTO"
_ID = "9001015800083"


@pytest_asyncio.fixture
async def crypto_cleanup():
    from tests.conftest import _TestSession
    yield
    async with _TestSession() as db:
        await db.execute(text("update digital_prfs set case_id=null where case_number like :m"),
                         {"m": f"{_MARKER}%"})
        await db.execute(text("delete from digital_prfs where case_number like :m"),
                         {"m": f"{_MARKER}%"})
        await db.execute(text("delete from cases where patient_name like :m"),
                         {"m": f"%{_MARKER}%"})
        await db.commit()


# ── the primitives ──────────────────────────────────────────────────────────

def test_the_hash_ignores_formatting():
    """'900101 5800 083' and '9001015800083' are the same person. A lookup that
    missed on a space would silently create a duplicate patient record."""
    assert id_hash("900101 5800 083") == id_hash(_ID)
    assert id_hash("9001-015-800-083") == id_hash(_ID)


def test_the_hash_is_keyed_not_a_bare_digest():
    """An SA ID is 13 digits with a checksum — a plain SHA-256 of every possible
    value is computable on a laptop, so the lookup hash must be keyed."""
    import hashlib
    assert id_hash(_ID) != hashlib.sha256(_ID.encode()).hexdigest()


def test_encryption_is_idempotent_so_a_backfill_can_be_rerun():
    token = encrypt_id(_ID)
    assert encrypt_id(token) == token
    assert decrypt_id(token) == _ID


def test_a_plaintext_value_still_reads_correctly():
    """Rows written before this shipped hold plaintext. They must keep serving
    the real number while the backfill runs, not blanks on patient records."""
    assert decrypt_id(_ID) == _ID
    assert not looks_encrypted(_ID)


# ── through the ORM, against a real database ────────────────────────────────

async def test_the_case_id_is_ciphertext_on_disk_and_plaintext_in_python(crypto_cleanup):
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        case = Case(patient_name=f"{_MARKER} Patient", patient_id_number=_ID)
        db.add(case)
        await db.commit()
        case_id = case.id

    # Raw SQL — underneath the ORM, which is the only way to see what is really
    # stored. Reading it back through the ORM would just prove it is consistent
    # with itself.
    async with _TestSession() as db:
        stored = (await db.execute(
            text("select patient_id_number, patient_id_hash from cases where id = :i"),
            {"i": case_id},
        )).one()
        assert _ID not in stored[0], "the ID number is on disk in plaintext"
        assert looks_encrypted(stored[0]), f"not a Fernet token: {stored[0][:20]}"
        assert stored[1] == id_hash(_ID), "the lookup hash was not maintained"

    async with _TestSession() as db:
        case = (await db.execute(select(Case).where(Case.id == case_id))).scalar_one()
        assert case.patient_id_number == _ID, "the application no longer sees the ID"


async def test_the_prf_form_data_id_is_encrypted_but_the_rest_is_not(crypto_cleanup):
    """Only that one key is transformed. Encrypting the whole blob would make
    the record unqueryable and put the clinical narrative behind a decrypt."""
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

        prf = DigitalPRF(
            provider_id=provider.id, crew_member_1_id=crew.id,
            prf_number=top + 11000,
            case_number=f"{_MARKER}-{uuid.uuid4().hex[:8]}",
            status=PRFStatus.DRAFT,
            form_data={"patient_id_number": _ID, "patient_name": "Thabo",
                       "chief_complaint": "chest pain"},
        )
        db.add(prf)
        await db.commit()
        pid = prf.id

    async with _TestSession() as db:
        raw = (await db.execute(
            text("select form_data->>'patient_id_number', form_data->>'chief_complaint' "
                 "from digital_prfs where id = :i"), {"i": pid},
        )).one()
        assert _ID not in (raw[0] or ""), "the ID is plaintext inside form_data"
        assert looks_encrypted(raw[0])
        assert raw[1] == "chest pain", "an unrelated clinical field was altered"

    async with _TestSession() as db:
        prf = (await db.execute(select(DigitalPRF).where(DigitalPRF.id == pid))).scalar_one()
        assert prf.form_data["patient_id_number"] == _ID
        assert prf.form_data["chief_complaint"] == "chest pain"


async def test_a_numeric_id_from_ocr_does_not_break_the_save(crypto_cleanup):
    """OCR paths have delivered the ID as an int before — reaching .encode() on
    a number would raise and fail the whole save, losing the record."""
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
        prf = DigitalPRF(
            provider_id=provider.id, crew_member_1_id=crew.id,
            prf_number=top + 12000,
            case_number=f"{_MARKER}-{uuid.uuid4().hex[:8]}",
            status=PRFStatus.DRAFT,
            form_data={"patient_id_number": 9001015800083},
        )
        db.add(prf)
        await db.commit()
        pid = prf.id

    async with _TestSession() as db:
        prf = (await db.execute(select(DigitalPRF).where(DigitalPRF.id == pid))).scalar_one()
        assert prf.form_data["patient_id_number"] == _ID


async def test_a_case_can_still_be_found_by_id_without_decrypting(crypto_cleanup):
    """The whole reason for the hash column: equality lookup and duplicate
    detection survive encryption."""
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        db.add(Case(patient_name=f"{_MARKER} Findable", patient_id_number=_ID))
        await db.commit()

    async with _TestSession() as db:
        found = (await db.execute(
            select(Case).where(Case.patient_id_hash == id_hash("900101 5800 083"))
        )).scalars().all()
        assert len(found) >= 1, "an encrypted patient can no longer be found by ID"
        assert found[0].patient_id_number == _ID


async def test_changing_the_id_updates_the_hash(crypto_cleanup):
    """A hash left behind after an edit points at the wrong person."""
    from tests.conftest import _TestSession
    other = "8202025800086"

    async with _TestSession() as db:
        case = Case(patient_name=f"{_MARKER} Edited", patient_id_number=_ID)
        db.add(case)
        await db.commit()
        cid = case.id

    async with _TestSession() as db:
        case = (await db.execute(select(Case).where(Case.id == cid))).scalar_one()
        case.patient_id_number = other
        await db.commit()

    async with _TestSession() as db:
        stored = (await db.execute(
            text("select patient_id_hash from cases where id = :i"), {"i": cid},
        )).scalar_one()
        assert stored == id_hash(other), "the lookup hash still points at the old ID"


def test_nothing_logs_a_whole_id_number():
    """The masking helper in the backfill must never emit a usable identifier."""
    from encrypt_patient_ids import _mask
    masked = _mask(_ID)
    assert _ID not in masked
    assert masked.startswith("90") and masked.endswith("83")
    assert normalise_id(masked) != normalise_id(_ID)
