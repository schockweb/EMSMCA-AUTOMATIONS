"""
Correcting a failed PRF must not poison the provider's numbering.

A correction creates a replacement row numbered `original.prf_number + 100000`
— an out-of-band value chosen only to dodge the (provider_id, prf_number) unique
constraint. `_next_prf_number` derived the next number from the provider's own
max, and counted that row, so one correction of PRF #5 pushed the provider's
next real call to #100006 and each later correction added another 100 000.

That destroys the per-provider sequential numbering `prf_start_number` exists to
carry over from the provider's paper books, and the bogus number propagates into
the case number.
"""
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.api.digital_prf import _next_prf_number
from app.api.failed_prfs import _next_correction_case_number
from app.models.digital_prf import DigitalPRF, PRFStatus
from app.models.service_provider import ServiceProvider

_SLUG = "pytest-numbering-provider"


@pytest_asyncio.fixture
async def numbering_provider():
    """A provider of its own, so these row inserts cannot disturb other tests."""
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        provider = (await db.execute(
            select(ServiceProvider).where(ServiceProvider.slug == _SLUG)
        )).scalar_one_or_none()
        if provider is None:
            provider = ServiceProvider(
                name="PyTest Numbering Co", slug=_SLUG,
                pr_number="TEST-PR-NUM", is_active=True,
            )
            db.add(provider)
            await db.flush()

        # Start from a clean slate on every run. Corrections must go FIRST:
        # digital_prfs.correction_of_id is a self-referencing FK, so deleting an
        # original while its correction still points at it raises
        # ForeignKeyViolationError and rolls the whole cleanup back.
        for correction_first in (True, False):
            rows = (await db.execute(
                select(DigitalPRF).where(
                    DigitalPRF.provider_id == provider.id,
                    DigitalPRF.correction_of_id.is_not(None) if correction_first
                    else DigitalPRF.correction_of_id.is_(None),
                )
            )).scalars().all()
            for row in rows:
                await db.delete(row)
            await db.flush()

        provider.prf_start_number = 0
        await db.commit()
        await db.refresh(provider)
        return provider


async def _add_prf(provider, number, *, correction_of=None, case_number=None):
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        prf = DigitalPRF(
            provider_id=provider.id,
            prf_number=number,
            case_number=case_number,
            status=PRFStatus.SUBMITTED,
            form_data={},
            correction_of_id=correction_of,
        )
        db.add(prf)
        await db.commit()
        await db.refresh(prf)
        return prf


@pytest.mark.asyncio
async def test_correction_does_not_advance_the_sequence(numbering_provider):
    """The regression itself."""
    from tests.conftest import _TestSession

    original = await _add_prf(numbering_provider, 5)

    async with _TestSession() as db:
        before = await _next_prf_number(db, numbering_provider)
    assert before == 6, f"expected the next PRF to be 6, got {before}"

    # An admin corrects PRF #5 — the replacement row is numbered 100005.
    await _add_prf(numbering_provider, 100005, correction_of=original.id)

    async with _TestSession() as db:
        after = await _next_prf_number(db, numbering_provider)

    assert after == 6, (
        f"a correction pushed the provider's next PRF number to {after}; "
        f"the sequence must stay at 6"
    )


@pytest.mark.asyncio
async def test_repeated_corrections_do_not_compound(numbering_provider):
    """Each correction used to add another 100 000."""
    from tests.conftest import _TestSession

    first = await _add_prf(numbering_provider, 5)
    second = await _add_prf(numbering_provider, 6)
    await _add_prf(numbering_provider, 100005, correction_of=first.id)
    await _add_prf(numbering_provider, 100006, correction_of=second.id)

    async with _TestSession() as db:
        nxt = await _next_prf_number(db, numbering_provider)

    assert nxt == 7, f"two corrections left the next number at {nxt}, expected 7"


@pytest.mark.asyncio
async def test_ordinary_prfs_still_advance_the_sequence(numbering_provider):
    """The exclusion must apply ONLY to corrections — otherwise numbering stalls
    and every new PRF collides on the unique constraint."""
    from tests.conftest import _TestSession

    await _add_prf(numbering_provider, 5)
    await _add_prf(numbering_provider, 6)
    await _add_prf(numbering_provider, 7)

    async with _TestSession() as db:
        nxt = await _next_prf_number(db, numbering_provider)

    assert nxt == 8, f"ordinary PRFs no longer advance the sequence (got {nxt})"


@pytest.mark.asyncio
async def test_paper_baseline_is_still_honoured(numbering_provider):
    """prf_start_number carries the provider's paper-book count at onboarding."""
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        provider = (await db.execute(
            select(ServiceProvider).where(ServiceProvider.id == numbering_provider.id)
        )).scalar_one()
        provider.prf_start_number = 690
        await db.commit()
        await db.refresh(provider)

        nxt = await _next_prf_number(db, provider)

    assert nxt == 691, f"the paper baseline was ignored (got {nxt})"


# ── The case number the correction gets ────────────────────────────────────

@pytest.mark.asyncio
async def test_correction_case_number_is_derived_from_the_original(numbering_provider):
    """It used to be left NULL forever, so the corrected record — the one that
    actually gets billed — could not be found by the admin search, and the PDF
    emailed to the facility was titled with the bogus 100005."""
    from tests.conftest import _TestSession

    original = await _add_prf(numbering_provider, 5, case_number="NUMCO-2026-07-000005")

    async with _TestSession() as db:
        derived = await _next_correction_case_number(db, original)

    assert derived == "NUMCO-2026-07-000005-C1"
    # Searching the original number must still find the correction.
    assert "000005" in derived


@pytest.mark.asyncio
async def test_correction_case_number_avoids_collisions(numbering_provider):
    """case_number is globally unique — a second correction must not clash."""
    from tests.conftest import _TestSession

    original = await _add_prf(numbering_provider, 5, case_number="NUMCO-2026-07-000005")
    await _add_prf(
        numbering_provider, 100005,
        correction_of=original.id, case_number="NUMCO-2026-07-000005-C1",
    )

    async with _TestSession() as db:
        derived = await _next_correction_case_number(db, original)

    assert derived == "NUMCO-2026-07-000005-C2", f"got {derived!r}"


@pytest.mark.asyncio
async def test_correction_case_number_respects_the_50_char_column(numbering_provider):
    from tests.conftest import _TestSession

    long_base = "X" * 50
    original = await _add_prf(numbering_provider, 5, case_number=long_base)

    async with _TestSession() as db:
        derived = await _next_correction_case_number(db, original)

    assert derived is not None
    assert len(derived) <= 50, f"case number is {len(derived)} chars, column is String(50)"
    assert derived.endswith("-C1")


@pytest.mark.asyncio
async def test_no_case_number_on_the_original_yields_none(numbering_provider):
    """A PRF that failed before a case number was assigned has nothing to derive
    from — None is honest, an invented identifier is not."""
    from tests.conftest import _TestSession

    original = await _add_prf(numbering_provider, 5, case_number=None)

    async with _TestSession() as db:
        assert await _next_correction_case_number(db, original) is None


# ── End-to-end through the endpoint ────────────────────────────────────────

@pytest.mark.asyncio
async def test_correct_endpoint_assigns_the_case_number(client, auth_headers, numbering_provider):
    """Exercise PUT /correct itself, not just the helper.

    The helper tests above all passed with the endpoint mutated to write
    `case_number = None` again — they never proved the endpoint USES the helper.
    This one does.
    """
    if auth_headers is None:
        pytest.skip("seed admin unavailable")

    from tests.conftest import _TestSession

    original = await _add_prf(
        numbering_provider, 5, case_number="NUMCO-2026-07-000005"
    )
    async with _TestSession() as db:
        row = (await db.execute(
            select(DigitalPRF).where(DigitalPRF.id == original.id)
        )).scalar_one()
        row.status = PRFStatus.FAILED
        await db.commit()

    resp = await client.put(
        f"/api/failed-prfs/{original.id}/correct",
        headers=auth_headers,
        json={"form_data": {"patient_name": "Corrected Name"}},
    )
    # 503 is the correct answer when no broker is reachable (this environment) —
    # the correction is committed before the enqueue, and the endpoint now says
    # so instead of returning a bare 500 that invites a duplicate retry.
    assert resp.status_code in (200, 503), f"correction failed: {resp.text[:300]}"
    if resp.status_code == 503:
        assert "saved" in resp.json()["detail"].lower()

    async with _TestSession() as db:
        correction = (await db.execute(
            select(DigitalPRF).where(DigitalPRF.correction_of_id == original.id)
        )).scalar_one()

        assert correction.case_number is not None, (
            "the corrected PRF — the record that actually gets billed — was "
            "created with no case number, so it cannot be found by the admin "
            "search and its emailed PDF is titled with the +100000 number"
        )
        assert correction.case_number.startswith("NUMCO-2026-07-000005")
        assert correction.case_number.endswith("-C1")
