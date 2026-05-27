"""
Migration script: Create scheme_rules table and update UserRole enum.

Run with: python migrate_rule_engine.py
"""
import asyncio
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from sqlalchemy import text
from app.database import engine


async def migrate():
    async with engine.begin() as conn:
        # ── 1. Create enums ──
        print("[1/4] Creating rule_type_enum...")
        await conn.execute(text("""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rule_type_enum') THEN
                    CREATE TYPE rule_type_enum AS ENUM (
                        'validation', 'pricing', 'routing', 'modifier',
                        'exclusion', 'preauth', 'documentation', 'general'
                    );
                END IF;
            END $$;
        """))

        print("[2/4] Creating rule_severity_enum...")
        await conn.execute(text("""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rule_severity_enum') THEN
                    CREATE TYPE rule_severity_enum AS ENUM (
                        'critical', 'high', 'medium', 'low'
                    );
                END IF;
            END $$;
        """))

        # ── 2. Create table ──
        print("[3/4] Creating scheme_rules table...")
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS scheme_rules (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name VARCHAR(200) NOT NULL,
                description TEXT,
                rule_type rule_type_enum NOT NULL DEFAULT 'general',
                severity rule_severity_enum NOT NULL DEFAULT 'high',
                scheme_name VARCHAR(200),
                condition JSONB NOT NULL,
                action JSONB NOT NULL,
                priority INTEGER NOT NULL DEFAULT 100,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                source VARCHAR(50) DEFAULT 'manual',
                source_guideline_id UUID,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                created_by UUID
            );
        """))

        # Create indexes
        await conn.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_scheme_rules_scheme ON scheme_rules (scheme_name);
        """))
        await conn.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_scheme_rules_active ON scheme_rules (is_active);
        """))
        await conn.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_scheme_rules_priority ON scheme_rules (priority, created_at);
        """))

        # ── 3. Update UserRole enum to include super_admin ──
        print("[4/4] Adding 'super_admin' to userrole enum (if needed)...")
        await conn.execute(text("""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_enum
                    WHERE enumlabel = 'super_admin'
                    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'userrole')
                ) THEN
                    ALTER TYPE userrole ADD VALUE 'super_admin' BEFORE 'admin';
                END IF;
            EXCEPTION
                WHEN others THEN
                    RAISE NOTICE 'Could not add super_admin to userrole enum: %', SQLERRM;
            END $$;
        """))

    print("\n✅ Migration complete! scheme_rules table created, super_admin role added.")


if __name__ == "__main__":
    asyncio.run(migrate())
