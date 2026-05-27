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
import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

# ── 1. Set env vars BEFORE importing the app ────────────────────────────────
os.environ["DATABASE_URL"] = os.getenv(
    "TEST_DATABASE_URL",
    os.getenv("DATABASE_URL", "postgresql+asyncpg://ems_admin:ems_secure_2024@localhost:5432/ems_claims"),
)
os.environ["SECRET_KEY"] = "ems-portal-super-secret-key-2024"
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
    login_data = {"username": "admin@emsclaims.co.za", "password": "Admin@2024!"}
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


@pytest_asyncio.fixture(autouse=True)
async def _ensure_test_crew():
    """
    Idempotently create the test provider + Crew A + Crew B before the first test.
    Uses _TestSession (NullPool) — isolated from any in-flight app requests.
    """
    global _TEST_CREW_BOOTSTRAPPED
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
