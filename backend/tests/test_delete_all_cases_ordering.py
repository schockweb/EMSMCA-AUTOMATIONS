"""
DELETE /api/cases/all — it has to actually finish, and it must not take the
clinical record with it.

The route deleted `documents` while `digital_prfs.document_id` still pointed at
them, so every call on an instance with real data died on

    ForeignKeyViolationError: update or delete on table "documents" violates
    foreign key constraint "digital_prfs_document_id_fkey"

and rolled the whole wipe back. It knew about four of the eight tables that
reference cases/claims/documents; the other four (digital_prfs on both of its
FKs, eras, edi_submissions, and claims' own amended_by_id) each 500'd it. It
passed review because it only ever ran against a database with nothing in it —
which is exactly the state in which no FK can fire.

WHY THIS FILE BUILDS ITS OWN DATABASE
-------------------------------------
Asserting the wipe SUCCEEDS means asserting that every case in the database is
gone afterwards. The existing authz test says so in as many words and refuses to
do it: run against a developer's local DB — which conftest permits, with a
warning — that assertion deletes their working data, and run mid-suite it
deletes whatever a sibling module was relying on.

So the destructive test gets a database of its own: created here, schema built
from the models, dropped at the end. Nothing outside it can be reached, so the
test is safe to run anywhere the suite is safe to run.
"""
import os
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

pytestmark = pytest.mark.asyncio

_SCRATCH_DB = "ems_wipe_ordering_scratch"


async def _maintenance_connection():
    """asyncpg connection to the `postgres` database on the configured server.

    Raw asyncpg rather than SQLAlchemy: CREATE/DROP DATABASE cannot run inside a
    transaction block, and cannot be issued as a prepared statement either,
    which is the path the asyncpg dialect takes.
    """
    import asyncpg

    url = make_url(os.environ["DATABASE_URL"])
    return await asyncpg.connect(
        user=url.username,
        password=url.password,
        host=url.host,
        port=url.port or 5432,
        database="postgres",
    )


@pytest_asyncio.fixture
async def scratch_session():
    """A throwaway database wired into the app for the duration of one test.

    Yields its sessionmaker so the test can seed and inspect rows directly.
    """
    import asyncpg

    from app.database import Base, get_db as _real_get_db
    from tests.conftest import app

    try:
        admin = await _maintenance_connection()
    except Exception as exc:  # unreachable server, wrong credentials
        pytest.skip(f"no maintenance database available for a scratch DB: {exc}")

    try:
        await admin.execute(f'DROP DATABASE IF EXISTS "{_SCRATCH_DB}"')
        await admin.execute(f'CREATE DATABASE "{_SCRATCH_DB}"')
    except asyncpg.InsufficientPrivilegeError:
        await admin.close()
        pytest.skip("the test database role may not CREATE DATABASE")
    finally:
        if not admin.is_closed():
            await admin.close()

    url = make_url(os.environ["DATABASE_URL"]).set(database=_SCRATCH_DB)
    engine = create_async_engine(url, poolclass=NullPool)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _scratch_get_db():
        async with Session() as session:
            try:
                yield session
            finally:
                await session.close()

    # conftest already overrides get_db onto the shared test database; put that
    # back afterwards rather than dropping the override entirely, or every test
    # collected after this one talks to a database that no longer exists.
    previous = app.dependency_overrides.get(_real_get_db)
    app.dependency_overrides[_real_get_db] = _scratch_get_db
    try:
        yield Session
    finally:
        if previous is not None:
            app.dependency_overrides[_real_get_db] = previous
        else:
            app.dependency_overrides.pop(_real_get_db, None)
        await engine.dispose()
        admin = await _maintenance_connection()
        try:
            await admin.execute(f'DROP DATABASE IF EXISTS "{_SCRATCH_DB}" WITH (FORCE)')
        finally:
            await admin.close()


async def _seed_full_pipeline(Session) -> dict:
    """One case carrying every row type that references it, directly or not.

    The point is coverage of the FK graph, not realism: each table below is one
    the wipe has to step over in the right order.
    """
    from app.models.auth_request import SchemeAuthRequest
    from app.models.case import Case
    from app.models.claim import Claim
    from app.models.claim_line import ClaimLine
    from app.models.digital_prf import DigitalPRF, PRFStatus
    from app.models.document import Document, OCRStatus
    from app.models.edi_submission import EDIFormat, EDISubmission
    from app.models.era import ERA
    from app.models.rfi import RFI
    from app.models.service_provider import ServiceProvider
    from app.models.user import User, UserRole
    from app.utils.security import hash_password

    ids: dict = {}

    async with Session() as db:
        super_admin = User(
            email="wipe_superadmin_pytest@emsclaims.test",
            hashed_password=hash_password("Wipe-Ordering-2026!"),
            full_name="PyTest Wipe SuperAdmin",
            role=UserRole.SUPER_ADMIN,
            bhf_practice_number="0000000",
        )
        provider = ServiceProvider(
            name="PyTest Wipe Provider", slug="pytest-wipe-provider", is_active=True,
        )
        db.add_all([super_admin, provider])
        await db.flush()

        case = Case(patient_name="Wipe Ordering Fixture", preauth_number="AUTH-WIPE-1")
        db.add(case)
        await db.flush()

        document = Document(
            case_id=case.id,
            original_filename="wipe-fixture-prf.pdf",
            # Deliberately a path that does not exist: the route unlinks files
            # after committing, and os.path.exists gates that, so nothing on disk
            # is touched by this test.
            storage_uri="pytest-wipe-fixture/does-not-exist.pdf",
            document_type="PRF",
            ocr_status=OCRStatus.COMPLETED,
            needs_hitl_review=False,
        )
        claim = Claim(case_id=case.id)
        db.add_all([document, claim])
        await db.flush()

        # The FK that fired in production: a submitted PRF always has a document.
        prf = DigitalPRF(
            provider_id=provider.id,
            prf_number=1,
            status=PRFStatus.PROCESSED,
            case_id=case.id,
            document_id=document.id,
            form_data={"patient_surname": "Fixture", "call_type": "Primary"},
        )
        edi = EDISubmission(
            claim_id=claim.id,
            clearinghouse="healthbridge",
            edi_format=EDIFormat.HEALTHBRIDGE_XML,
        )
        db.add_all([
            prf,
            edi,
            ClaimLine(claim_id=claim.id, line_number=1),
            RFI(
                claim_id=claim.id,
                reason_code="MISSING_PREAUTH",
                reason_description="wipe-ordering fixture",
            ),
            SchemeAuthRequest(case_id=case.id),
            SchemeAuthRequest(case_id=case.id, claim_id=claim.id),
        ])
        await db.flush()

        db.add(ERA(claim_id=claim.id, edi_submission_id=edi.id))
        # A voided claim naming its replacement — claims.amended_by_id is a
        # self-reference, so deleting the claims of one case can trip over it.
        db.add(Claim(case_id=case.id, voided=True, amended_by_id=claim.id))

        await db.commit()

        ids = {
            "user_id": super_admin.id,
            "case_id": case.id,
            "document_id": document.id,
            "prf_id": prf.id,
        }

    return ids


@pytest_asyncio.fixture
async def seeded(scratch_session):
    ids = await _seed_full_pipeline(scratch_session)
    return scratch_session, ids


def _super_admin_headers(user_id: uuid.UUID) -> dict:
    """Mint the token directly rather than POSTing /api/auth/login.

    The login route would be the more faithful path, but it also drags in the
    per-IP auth rate limit and the lockout tables for no benefit here — what is
    under test is the route body, and get_current_user resolves the user through
    the same overridden get_db.
    """
    from app.utils.security import create_access_token

    return {"Authorization": f"Bearer {create_access_token({'sub': str(user_id)})}"}


async def test_wipe_completes_with_prfs_linked_to_documents(client, seeded):
    """The regression: 204, not a 500 from digital_prfs_document_id_fkey."""
    from app.models.case import Case
    from app.models.claim import Claim
    from app.models.document import Document

    Session, ids = seeded

    resp = await client.delete("/api/cases/all", headers=_super_admin_headers(ids["user_id"]))
    assert resp.status_code == 204, (
        f"the wipe failed with {resp.status_code}: {resp.text}"
    )

    async with Session() as db:
        for model, label in ((Case, "cases"), (Document, "documents"), (Claim, "claims")):
            remaining = (await db.execute(select(func.count()).select_from(model))).scalar_one()
            assert remaining == 0, f"{remaining} {label} survived the wipe"


async def test_wipe_keeps_the_prf_and_unlinks_it(client, seeded):
    """The PRF is the crew's record of the call, not a billing artefact.

    Deleting it along with the case would destroy the source document under a
    seven-year retention obligation, and no rollback brings it back. The route
    severs both FKs instead — the same thing the single-case delete does.
    """
    from app.models.digital_prf import DigitalPRF

    Session, ids = seeded

    resp = await client.delete("/api/cases/all", headers=_super_admin_headers(ids["user_id"]))
    assert resp.status_code == 204, resp.text

    async with Session() as db:
        prf = (await db.execute(
            select(DigitalPRF).where(DigitalPRF.id == ids["prf_id"])
        )).scalar_one_or_none()

    assert prf is not None, "the wipe destroyed the clinical record"
    assert prf.document_id is None, "digital_prfs.document_id still names a deleted document"
    assert prf.case_id is None, "digital_prfs.case_id still names a deleted case"


async def test_wipe_clears_every_dependent_row(client, seeded):
    """Nothing may be left pointing at a case that no longer exists.

    Counting the dependants rather than trusting the 204: a FK the route forgot
    shows up here as an orphan, and one it deletes in the wrong order shows up
    as the 500 the test above catches.
    """
    from app.models.auth_request import SchemeAuthRequest
    from app.models.claim_line import ClaimLine
    from app.models.edi_submission import EDISubmission
    from app.models.era import ERA
    from app.models.rfi import RFI

    Session, ids = seeded

    resp = await client.delete("/api/cases/all", headers=_super_admin_headers(ids["user_id"]))
    assert resp.status_code == 204, resp.text

    async with Session() as db:
        for model in (ClaimLine, RFI, SchemeAuthRequest, EDISubmission, ERA):
            remaining = (await db.execute(select(func.count()).select_from(model))).scalar_one()
            assert remaining == 0, (
                f"{remaining} {model.__tablename__} rows outlived the claims they belong to"
            )


async def test_wipe_is_still_refused_to_a_plain_admin_on_this_database(client, seeded):
    """The guard, asserted where a successful wipe is also demonstrated.

    Separately covered in test_authz_hardening.py; repeated here because this is
    the one database on which the allowed path is proven to work, so a 403 here
    cannot be the accidental pass you get from a route that 500s for everyone.
    """
    from app.models.user import User, UserRole
    from app.utils.security import hash_password

    Session, ids = seeded

    async with Session() as db:
        admin = User(
            email="wipe_admin_pytest@emsclaims.test",
            hashed_password=hash_password("Wipe-Ordering-2026!"),
            full_name="PyTest Wipe Admin",
            role=UserRole.ADMIN,
            bhf_practice_number="0000000",
        )
        db.add(admin)
        await db.commit()
        admin_id = admin.id

    resp = await client.delete("/api/cases/all", headers=_super_admin_headers(admin_id))
    assert resp.status_code == 403, (
        f"a plain ADMIN reached the wipe-everything route ({resp.status_code})"
    )
