"""
Database migration — adds security hardening columns and tables.

Run with: python migrate_security.py
"""
import asyncio
from sqlalchemy import text
from app.database import AsyncSessionLocal

MIGRATIONS = [
    # ── Account lockout columns on users ──
    """
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER DEFAULT 0;
    """,
    """
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP WITH TIME ZONE;
    """,
    """
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP WITH TIME ZONE;
    """,

    # ── Token blacklist table ──
    """
    CREATE TABLE IF NOT EXISTS token_blacklist (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        jti VARCHAR(64) NOT NULL UNIQUE,
        user_id UUID,
        token_type VARCHAR(10) NOT NULL DEFAULT 'access',
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        revoked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_token_blacklist_jti ON token_blacklist(jti);
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_token_blacklist_user_id ON token_blacklist(user_id);
    """,
]


async def run_migrations():
    async with AsyncSessionLocal() as db:
        for sql in MIGRATIONS:
            try:
                await db.execute(text(sql.strip()))
                print(f"✓ Executed: {sql.strip()[:60]}...")
            except Exception as e:
                print(f"⚠ Skipped (may already exist): {e}")
        await db.commit()
        print("\n✅ Security migrations complete.")


if __name__ == "__main__":
    asyncio.run(run_migrations())
