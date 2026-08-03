"""
EMS Medical Claims Ingestion Portal — Database Layer
Async SQLAlchemy engine and session factory for PostgreSQL.

Connection pool tuned for high concurrency (500+ ambulances).
"""
from __future__ import annotations
import logging
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
import re as _re

from app.config import get_settings

logger = logging.getLogger("ems.database")

settings = get_settings()

if settings.DATABASE_URL.startswith("sqlite"):
    engine = create_async_engine(
        settings.DATABASE_URL,
        echo=False,
    )
else:
    # Detect Supabase (PgBouncer) — disable prepared statement cache because
    # PgBouncer reassigns backend connections and breaks server-side state.
    # For local Postgres, prepared statements give a significant perf boost.
    _is_supabase = "supabase" in settings.DATABASE_URL or "ssl=require" in settings.DATABASE_URL
    _connect_args: dict = {}
    if _is_supabase:
        _connect_args = {
            "prepared_statement_cache_size": 0,
            "statement_cache_size": 0,
        }

    # ── Database TLS: encrypt AND verify ───────────────────────────────────
    #
    # `ssl.create_default_context()` verifies the certificate chain against the
    # system trust store AND checks the hostname (check_hostname=True,
    # verify_mode=CERT_REQUIRED). That is the verify-full behaviour we want.
    #
    # THE GAP THIS CLOSES. The context above was only ever built when the
    # DB_SSL_MODE setting was "require". Production does not set that variable —
    # it puts `?ssl=require` in DATABASE_URL instead, which SQLAlchemy forwards
    # to asyncpg as the STRING "require", and asyncpg's string form encrypts
    # WITHOUT validating the certificate or the hostname. The boot guard in
    # config.py accepts either mechanism, so production passed the check while
    # getting no verification at all: an attacker positioned between the app and
    # the database could present any certificate.
    #
    # Now either spelling produces the verifying context, and the URL parameter
    # is stripped so asyncpg cannot override it with its weaker string form.
    #
    # Verified against the live Azure server on 2026-08-03 before shipping: the
    # certificate chains to a trusted root already present in the image and the
    # hostname matches, so no CA bundle file is needed. A negative control with
    # an untrusted CA store was correctly refused — proof the check is real
    # rather than merely configured.
    _url_wants_tls = bool(_re.search(r"[?&]ssl(mode)?=(require|verify-ca|verify-full)",
                                     settings.DATABASE_URL, _re.I))
    if settings.DB_SSL_MODE in ("require", "verify-ca", "verify-full") or _url_wants_tls:
        import ssl as _ssl
        _connect_args["ssl"] = _ssl.create_default_context()
        logger.info("Database TLS: encrypted and certificate-verified (verify-full)")

    # The ssl/sslmode query parameter is removed from the URL once a verifying
    # context is in connect_args. Leaving it would hand asyncpg the string form
    # as well, and the string form is the one that skips verification.
    _engine_url = settings.DATABASE_URL
    if "ssl" in _connect_args:
        _engine_url = _re.sub(r"[?&]ssl(mode)?=[^&]*", "", _engine_url)

    engine = create_async_engine(
        _engine_url,
        echo=False,
        # ── Connection Pool ────────────────────────────────────────────
        pool_size=settings.DB_POOL_SIZE,
        max_overflow=settings.DB_MAX_OVERFLOW,
        pool_timeout=settings.DB_POOL_TIMEOUT,
        pool_recycle=settings.DB_POOL_RECYCLE,
        pool_pre_ping=True,
        connect_args=_connect_args,
    )


AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""
    pass


async def get_db():
    """Dependency injection: yields an async DB session."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()


async def create_tables():
    """Create all tables — used for dev/testing. Production uses Alembic."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
