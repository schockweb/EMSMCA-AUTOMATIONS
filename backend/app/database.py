"""
EMS Medical Claims Ingestion Portal — Database Layer
Async SQLAlchemy engine and session factory for PostgreSQL.

Connection pool tuned for high concurrency (500+ ambulances).
"""
from __future__ import annotations
import logging
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
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

    engine = create_async_engine(
        settings.DATABASE_URL,
        echo=False,
        # ── Connection Pool ──────────────────────────────────────
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
