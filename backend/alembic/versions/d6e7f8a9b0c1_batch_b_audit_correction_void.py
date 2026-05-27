"""Batch B: Audit enrichment + correction immutability + void/rebill.

Revision ID: d6e7f8a9b0c1
Revises: c5d6e7f8a9b0
Create Date: 2026-05-26 15:30:00.000000

Changes:
  1. audit_logs: Add before_state, after_state (JSONB), notes (TEXT)
  2. digital_prfs: Add correction_of_id (FK self), add CORRECTED to prf_status enum
  3. claims: Add voided, voided_at, voided_by, voided_reason, amended_by_id
"""
from alembic import op
import sqlalchemy as sa


revision = "d6e7f8a9b0c1"
down_revision = "c5d6e7f8a9b0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1. Audit log enrichment ──
    op.execute("""
        ALTER TABLE audit_logs
        ADD COLUMN IF NOT EXISTS before_state JSONB
    """)
    op.execute("""
        ALTER TABLE audit_logs
        ADD COLUMN IF NOT EXISTS after_state JSONB
    """)
    op.execute("""
        ALTER TABLE audit_logs
        ADD COLUMN IF NOT EXISTS notes TEXT
    """)

    # ── 2. Correction immutability ──
    # Add CORRECTED value to prf_status enum
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_enum
                WHERE enumlabel = 'corrected'
                AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'prf_status')
            ) THEN
                ALTER TYPE prf_status ADD VALUE 'corrected';
            END IF;
        END $$;
    """)

    # Add correction_of_id FK to self
    op.execute("""
        ALTER TABLE digital_prfs
        ADD COLUMN IF NOT EXISTS correction_of_id UUID REFERENCES digital_prfs(id)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_digital_prfs_correction_of
        ON digital_prfs(correction_of_id)
    """)

    # ── 3. Void & re-bill fields on claims ──
    op.execute("""
        ALTER TABLE claims
        ADD COLUMN IF NOT EXISTS voided BOOLEAN NOT NULL DEFAULT FALSE
    """)
    op.execute("""
        ALTER TABLE claims
        ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ
    """)
    op.execute("""
        ALTER TABLE claims
        ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES users(id)
    """)
    op.execute("""
        ALTER TABLE claims
        ADD COLUMN IF NOT EXISTS voided_reason TEXT
    """)
    op.execute("""
        ALTER TABLE claims
        ADD COLUMN IF NOT EXISTS amended_by_id UUID REFERENCES claims(id)
    """)


def downgrade() -> None:
    # Claims void fields
    op.execute("ALTER TABLE claims DROP COLUMN IF EXISTS amended_by_id")
    op.execute("ALTER TABLE claims DROP COLUMN IF EXISTS voided_reason")
    op.execute("ALTER TABLE claims DROP COLUMN IF EXISTS voided_by")
    op.execute("ALTER TABLE claims DROP COLUMN IF EXISTS voided_at")
    op.execute("ALTER TABLE claims DROP COLUMN IF EXISTS voided")

    # Correction FK
    op.execute("DROP INDEX IF EXISTS ix_digital_prfs_correction_of")
    op.execute("ALTER TABLE digital_prfs DROP COLUMN IF EXISTS correction_of_id")

    # Cannot remove enum value in PostgreSQL — leave 'corrected' in place

    # Audit log fields
    op.execute("ALTER TABLE audit_logs DROP COLUMN IF EXISTS notes")
    op.execute("ALTER TABLE audit_logs DROP COLUMN IF EXISTS after_state")
    op.execute("ALTER TABLE audit_logs DROP COLUMN IF EXISTS before_state")
