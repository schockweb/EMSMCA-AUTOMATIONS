"""
PRF search no longer scans the whole clinical blob.

Provider search ran `cast(form_data AS text) ILIKE '%term%'`, detoasting the
entire payload of every one of that provider's records. Production rows average
150,260 bytes and are mostly base64 — signatures, ID captures, scene photos —
none of which anyone searches. Measured on a provider with 559 PRFs, warm:
146 ms with the blob clause, 2.5 ms without.

`search_text` holds the same text minus the images and the ciphertext, and is
maintained by a database trigger so no write path can forget it.

These tests exist because a search index has the nastiest failure mode there is:
when it is wrong, nothing errors. The record is simply not found, and the person
looking concludes the patient was never entered.
"""
import importlib.util
import re
from pathlib import Path

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.asyncio

MIGRATION = (Path(__file__).resolve().parents[1]
             / "alembic" / "versions" / "d5b7e91a3c62_prf_search_text.py")


def _norm(sql: str) -> str:
    """Comparable SQL: comments gone, whitespace collapsed."""
    sql = re.sub(r"--[^\n]*", " ", sql)
    return re.sub(r"\s+", " ", sql).strip().lower()


# ════════════════════════════════════════════════════════════════════
# The two declarations must not drift
# ════════════════════════════════════════════════════════════════════

def test_the_model_and_the_migration_define_the_same_function():
    """The DDL is declared twice on purpose — the migration upgrades existing
    databases, the model's after_create covers create_all, which is how the test
    database, the dev database and every FRESH CLIENT INSTALL are built
    (bootstrap_schema.py builds from models, then stamps Alembic at head).

    Two copies can drift, and if they do, one class of installation gets a
    subtly different index and nobody finds out until a search comes back empty.
    """
    from app.models.digital_prf import SEARCH_TEXT_BUILD_FN, SEARCH_TEXT_TRIGGER_FN

    spec = importlib.util.spec_from_file_location("mig_search_text", MIGRATION)
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)

    assert _norm(SEARCH_TEXT_BUILD_FN) == _norm(mig.BUILD_FN), \
        "the model's search-text function has drifted from the migration's"
    assert _norm(SEARCH_TEXT_TRIGGER_FN) == _norm(mig.TRIGGER_FN), \
        "the model's trigger function has drifted from the migration's"


async def test_create_all_installs_the_trigger_not_just_the_column():
    """The failure this guards against. `search_text` is an ordinary column, so
    create_all makes it — and leaves it permanently NULL, because the thing that
    fills it is a trigger and create_all knows nothing about triggers. Every
    search on a freshly-installed instance would return nothing, silently."""
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        found = (await db.execute(text(
            "SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_digital_prfs_search_text'"
        ))).scalar()
    assert found == 1, (
        "the search trigger is missing from a create_all-built database — "
        "search_text will stay NULL and provider PRF search will find nothing"
    )


# ════════════════════════════════════════════════════════════════════
# What the trigger puts in, and keeps out
# ════════════════════════════════════════════════════════════════════

async def _search_text_for(form_data: dict) -> str:
    """Round-trip a form_data blob through the real trigger."""
    import uuid as _uuid
    from tests.conftest import _TestSession
    from app.models.digital_prf import DigitalPRF
    from app.models.service_provider import ServiceProvider

    async with _TestSession() as db:
        prov = ServiceProvider(name="SearchText Co", slug=f"stx-{_uuid.uuid4().hex[:8]}",
                               is_active=True)
        db.add(prov)
        await db.flush()
        prf = DigitalPRF(provider_id=prov.id, prf_number=1, form_data=form_data)
        db.add(prf)
        await db.commit()
        got = (await db.execute(
            text("SELECT search_text FROM digital_prfs WHERE id = :i"), {"i": prf.id}
        )).scalar()
        return got or ""


async def test_ordinary_fields_are_searchable():
    st = await _search_text_for({
        "patient_surname": "Nkosi",
        "medical_scheme": "GEMS",
        "chief_complaint": "Chest pain",
    })
    for expected in ("Nkosi", "GEMS", "Chest pain"):
        assert expected in st, f"{expected!r} is missing from search_text"


async def test_nested_clinical_fields_are_searchable():
    """The check that changed the design. Real production PRFs nest
    `medications`, `iv_therapy`, `airway_interventions`, `mechanism` and
    `circulation_interventions` — drug names and interventions. The first
    version indexed only top-level keys and would have dropped every one of
    them, which is a fast search that cannot find the drug you gave."""
    st = await _search_text_for({
        "medications": ["Adrenaline 1mg IV", "Morphine 5mg"],
        "iv_therapy": [{"fluid": "Ringers Lactate", "volume": "500ml"}],
        "patient_surname": "Dlamini",
    })
    assert "Adrenaline" in st, "a nested drug name is not searchable"
    assert "Ringers Lactate" in st, "a doubly-nested clinical value is not searchable"


async def test_encrypted_identifiers_are_excluded():
    """A Fernet token is ciphertext — matching it was never possible. Excluding
    by the `gAAAAA` version prefix rather than by a key list is deliberate: a
    field encrypted in future drops out on its own. A hardcoded list here would
    be the eleventh copy of one that has already been wrong once."""
    token = "gAAAAABm" + "x" * 90
    st = await _search_text_for({"patient_id_number": token, "patient_surname": "Botha"})
    assert token not in st, "an encrypted identifier was indexed as searchable text"
    assert "Botha" in st, "excluding ciphertext also dropped a normal field"


async def test_base64_images_are_excluded():
    """Signatures and photos are the bulk of a PRF and the entire reason the old
    query was slow. A long unbroken string is a blob, not prose."""
    blob = "iVBORw0KGgoAAAANSUhEUg" + "A" * 4000
    st = await _search_text_for({"patient_signature": blob, "chief_complaint": "MVA"})
    assert blob[:60] not in st, "a base64 image was indexed as searchable text"
    assert "MVA" in st
    assert len(st) < 500, f"search_text is {len(st)} bytes — a blob leaked in"


async def test_prose_survives_even_when_long():
    """The blob rule keys on 'long AND no whitespace'. A long narrative has
    spaces and must NOT be mistaken for base64."""
    narrative = "Patient found supine and alert. " * 40
    st = await _search_text_for({"events_hpi": narrative})
    assert "supine and alert" in st, "a long clinical narrative was excluded as a blob"


async def test_editing_a_prf_updates_its_search_text():
    """The whole point of using a trigger. If this ever regresses, records stay
    findable under their OLD contents and not their current ones."""
    import uuid as _uuid
    from tests.conftest import _TestSession
    from app.models.digital_prf import DigitalPRF
    from app.models.service_provider import ServiceProvider

    async with _TestSession() as db:
        prov = ServiceProvider(name="Edit Co", slug=f"edit-{_uuid.uuid4().hex[:8]}",
                               is_active=True)
        db.add(prov)
        await db.flush()
        prf = DigitalPRF(provider_id=prov.id, prf_number=1,
                         form_data={"patient_surname": "Original"})
        db.add(prf)
        await db.commit()
        prf_id = prf.id

    async with _TestSession() as db:
        await db.execute(
            text("UPDATE digital_prfs SET form_data = cast(:f AS json) WHERE id = :i"),
            {"f": '{"patient_surname": "Updated"}', "i": prf_id},
        )
        await db.commit()

    async with _TestSession() as db:
        st = (await db.execute(
            text("SELECT search_text FROM digital_prfs WHERE id = :i"), {"i": prf_id}
        )).scalar() or ""
    assert "Updated" in st, "search_text was not refreshed when form_data changed"
    assert "Original" not in st, "search_text still carries the superseded value"


# ════════════════════════════════════════════════════════════════════
# The endpoint actually uses it
# ════════════════════════════════════════════════════════════════════

def test_the_search_endpoint_no_longer_scans_the_blob():
    """A correct column that nothing queries is just a slower write path."""
    import inspect
    from app.api import providers

    src = inspect.getsource(providers)
    assert "DigitalPRF.search_text.ilike" in src, \
        "provider PRF search does not use search_text"
    assert "cast(DigitalPRF.form_data, Text).ilike" not in src, \
        "the full-blob ILIKE is still in the search path"
