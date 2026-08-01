"""
conftest.py — Shared fixtures for all test modules.
Uses httpx AsyncClient with ASGITransport for async testing.

Database isolation strategy:
  The app's engine uses AsyncAdaptedQueuePool with pool_pre_ping=True.
  Under test conditions, asyncpg leaves cleanup coroutines (Connection._cancel)
  unawaited when Starlette's BaseHTTPMiddleware swallows exceptions mid-request
  (e.g., on 400/404 responses). These orphaned coroutines poison the pool,
  causing the NEXT test's request to fail with 500.

  Fix: override the engine with NullPool before any test runs. NullPool creates
  a fresh connection per request and destroys it immediately — no pooling means
  no state leakage between tests.
"""
import os
import sys
import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

# ── 1. Set env vars BEFORE importing the app ────────────────────────────────
os.environ["DATABASE_URL"] = os.getenv(
    "TEST_DATABASE_URL",
    os.getenv("DATABASE_URL", "postgresql+asyncpg://ems_admin:ems_secure_2024@localhost:5432/ems_claims"),
)

# ── 1b. BROKER ──────────────────────────────────────────────────────────────
# Without this the suite inherits whatever CELERY_BROKER_URL the developer's
# .env names — in practice `amqp://…@ems_rabbitmq`, a hostname that only
# resolves inside Docker. The four submit-path tests then died on DNS
# (getaddrinfo failed) on every local run.
#
# That was not cosmetic. Those four tests cover the endpoint that queues the
# billing pipeline, and their being permanently red is precisely why the
# 2026-08-01 submit outage reached crews: the publish path had no working
# coverage anywhere, so nobody noticed it had stopped publishing. A red test
# nobody can make green is the same as no test.
#
# kombu's in-memory transport accepts a publish and drops it, which is all
# these tests need — they assert the ENDPOINT's contract (202, DRAFT→SUBMITTED,
# idempotent replay, submitted PRFs are undeletable), not the broker's.
#
# It deliberately does NOT prove the queue is declared with the right
# dead-letter arguments — an in-memory transport cannot, and that mismatch was
# the actual outage. CI runs a real RabbitMQ and
# tests/test_broker_queue_declare.py asserts it there.
os.environ.setdefault("CELERY_BROKER_URL", "memory://")

# ── 1a. PRODUCTION GUARD ────────────────────────────────────────────────────
# On 2026-07-28 this suite was run inside the production backend container.
# The fallback above picked up the container's own DATABASE_URL, so the tests
# ran against the live Azure database and injected a fake provider, two crew
# members and four PRFs (with cases, claims and documents) into real patient
# data. They were removable only because the fixtures happened to be namespaced.
#
# The tests are not at fault — they create and commit rows by design. The fault
# was that nothing checked WHERE they were pointed. A test suite must refuse to
# start rather than trust the ambient environment.
#
# Rule: the database must be local. CI runs postgres as a service on localhost
# (test_ems) and developers run it on localhost too; production is a managed
# Azure host, which is exactly what this refuses. Override deliberately with
# EMS_ALLOW_NONTEST_DB=1 only for a throwaway remote database.
def _assert_not_production(url: str) -> None:
    from urllib.parse import urlparse

    if os.getenv("EMS_ALLOW_NONTEST_DB") == "1":
        return

    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    dbname = (parsed.path or "").lstrip("/")
    local_hosts = {"localhost", "127.0.0.1", "::1", "postgres", "db", "ems_postgres"}

    if host not in local_hosts:
        raise RuntimeError(
            "\n"
            "═══════════════════════════════════════════════════════════════\n"
            " REFUSING TO RUN: tests are pointed at a NON-LOCAL database.\n"
            "═══════════════════════════════════════════════════════════════\n"
            f"  host     : {host or '(unset)'}\n"
            f"  database : {dbname or '(unset)'}\n"
            "\n"
            "  This suite CREATES AND COMMITS rows. Running it against a\n"
            "  managed/remote database writes fake providers, crew and PRFs\n"
            "  into real patient data.\n"
            "\n"
            "  Point TEST_DATABASE_URL at a local throwaway database, e.g.\n"
            "    TEST_DATABASE_URL=postgresql+asyncpg://u:p@localhost:5432/test_ems\n"
            "\n"
            "  If the remote database really is disposable, set\n"
            "    EMS_ALLOW_NONTEST_DB=1\n"
            "═══════════════════════════════════════════════════════════════\n"
        )

    if "test" not in dbname.lower():
        # Local but not obviously a test database — allowed (a developer's own
        # box is theirs to pollute) but never silently.
        sys.stderr.write(
            f"\nWARNING: tests will write to local database '{dbname}', whose name "
            f"does not contain 'test'. Rows WILL be created and committed.\n\n"
        )


_assert_not_production(os.environ["DATABASE_URL"])

# The suite pins its own secrets rather than inheriting whatever backend/.env
# happens to hold. APP_ENV is pinned too: Settings.APP_ENV defaults to
# "production", so without this the placeholder-secret validator would treat a
# test run as a production boot and refuse to start.
os.environ["APP_ENV"] = "test"
os.environ["SECRET_KEY"] = "ems-portal-super-secret-key-2024"
# A real Fernet key (44-char urlsafe base64). Test-only and committed on
# purpose — it encrypts nothing but fixtures.
os.environ["ENCRYPTION_KEY"] = "dGVzdC1vbmx5LWZlcm5ldC1rZXktZm9yLXVuaXQtdGU="
os.environ["LOG_LEVEL"] = "WARNING"
os.environ["LOG_FORMAT"] = "text"

# ── 2. Patch the engine to use NullPool (no connection reuse between requests)
from sqlalchemy.pool import NullPool
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
import app.database as _db_module

_test_engine = create_async_engine(
    os.environ["DATABASE_URL"],
    poolclass=NullPool,
)
_TestSession = async_sessionmaker(_test_engine, class_=AsyncSession, expire_on_commit=False)

# Monkey-patch the module-level singletons so every import of app.database
# picks up the NullPool engine — this must happen before app.main is imported.
_db_module.engine = _test_engine
_db_module.AsyncSessionLocal = _TestSession

# ── 3. Now import the app (it will use our patched engine/session) ───────────
from app.main import app  # noqa: E402 — intentionally after env setup

# Override the get_db dependency so all request handlers use our NullPool session
from app.database import get_db as _original_get_db  # noqa
import os
# Dev/test seed password — matches app.main.DEV_SEED_ADMIN_PASSWORD.
# The old hard-coded value leaked via a public repo and is burned.
SEED_ADMIN_PASSWORD = os.getenv("SEED_ADMIN_PASSWORD", "DevSeed!Change#2026")



async def _override_get_db():
    async with _TestSession() as session:
        try:
            yield session
        finally:
            await session.close()


app.dependency_overrides[_original_get_db] = _override_get_db


# ── 4. Shared pytest fixtures ────────────────────────────────────────────────

@pytest_asyncio.fixture
async def client():
    """Async HTTP client backed by the real FastAPI app (no real network)."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def auth_headers(client):
    """Admin auth headers — obtained by logging in as the seeded admin user."""
    login_data = {"username": "admin@emsclaims.co.za", "password": SEED_ADMIN_PASSWORD}
    response = await client.post("/api/auth/login", data=login_data)
    if response.status_code == 200:
        token = response.json().get("access_token", "")
        if token:
            return {"Authorization": f"Bearer {token}"}
    return None


# ── 5. One-time test crew bootstrap ─────────────────────────────────────────
# Creates the two dedicated test crew members directly via SQLAlchemy
# (bypassing the HTTP API) using our NullPool session.
# The global flag ensures this only runs once per test session.

_TEST_CREW_BOOTSTRAPPED = False
_SCHEMA_READY = False


async def _ensure_schema():
    """Create the schema and the seed admin on an empty database.

    A developer's local database already has both, so this was never needed —
    but CI starts a fresh postgres service every run, where every fixture query
    died with 'relation "service_providers" does not exist'. Creating the schema
    here (rather than relying on the app's startup hook) keeps the tests
    self-sufficient: ASGITransport does not run the lifespan, so nothing else
    would ever create these tables.
    """
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return

    from sqlalchemy import select
    from app.database import Base
    from app.models.user import User, UserRole
    from app.utils.security import hash_password

    # app.main is already imported above, so every model is registered on Base.
    async with _test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Seed the admin the auth fixtures log in as. Without it every
    # authenticated test silently skips, which looks like success.
    async with _TestSession() as db:
        existing = (await db.execute(
            select(User).where(User.email == "admin@emsclaims.co.za")
        )).scalar_one_or_none()
        if existing is None:
            db.add(User(
                email="admin@emsclaims.co.za",
                hashed_password=hash_password(SEED_ADMIN_PASSWORD),
                full_name="Test Administrator",
                role=UserRole.ADMIN,
                bhf_practice_number="0000000",
            ))
            await db.commit()

    _SCHEMA_READY = True


@pytest_asyncio.fixture(autouse=True)
async def _ensure_test_crew():
    """
    Idempotently create the test provider + Crew A + Crew B before the first test.
    Uses _TestSession (NullPool) — isolated from any in-flight app requests.
    """
    global _TEST_CREW_BOOTSTRAPPED
    await _ensure_schema()
    if _TEST_CREW_BOOTSTRAPPED:
        return

    from sqlalchemy import select
    from app.models.service_provider import ServiceProvider
    from app.models.crew_member import CrewMember
    from app.utils.security import hash_password

    async with _TestSession() as db:
        # Provider
        res = await db.execute(
            select(ServiceProvider).where(ServiceProvider.slug == "pytest-prf-provider")
        )
        provider = res.scalar_one_or_none()
        if not provider:
            provider = ServiceProvider(
                name="PyTest PRF Provider",
                slug="pytest-prf-provider",
                pr_number="TEST-PR-001",
                is_active=True,
            )
            db.add(provider)
            await db.flush()

        for email, name, initials, qual, hpcsa in [
            ("crew_a_pytest@emsclaims.test", "PyTest Crew Alpha", "PCA", "AEA", "TEST0001"),
            ("crew_b_pytest@emsclaims.test", "PyTest Crew Bravo", "PCB", "BAA", "TEST0002"),
        ]:
            r = await db.execute(select(CrewMember).where(CrewMember.email == email))
            if not r.scalar_one_or_none():
                db.add(CrewMember(
                    provider_id=provider.id,
                    email=email,
                    hashed_password=hash_password("Test@PRF2026!"),
                    full_name=name,
                    initials=initials,
                    qualification=qual,
                    hpcsa_number=hpcsa,
                    is_active=True,
                    role="crew",
                ))

        await db.commit()

    _TEST_CREW_BOOTSTRAPPED = True
