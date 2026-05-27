"""add_prf_failed_status

Phase 3: Add FAILED status to PRF pipeline.

1. Add 'failed' value to the prfstatus PostgreSQL enum type.
2. Add processing_error (TEXT), processing_attempts (INTEGER),
   and last_processing_at (TIMESTAMPTZ) columns to digital_prfs.
3. Add index on status column for fast filtering of failed PRFs.

Revision ID: b4c8d2e6f7a3
Revises: e8a3f1b2c4d5
Create Date: 2026-05-26
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'b4c8d2e6f7a3'
down_revision: Union[str, Sequence[str], None] = 'e8a3f1b2c4d5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ══════════════════════════════════════════════════════════════════════
    # 1. Add 'FAILED' to the prf_status enum type
    # ══════════════════════════════════════════════════════════════════════
    op.execute("ALTER TYPE prf_status ADD VALUE IF NOT EXISTS 'FAILED'")

    # ══════════════════════════════════════════════════════════════════════
    # 2. Add processing columns to digital_prfs
    # ══════════════════════════════════════════════════════════════════════
    op.execute("""
        ALTER TABLE digital_prfs
        ADD COLUMN IF NOT EXISTS processing_error TEXT
    """)
    op.execute("""
        ALTER TABLE digital_prfs
        ADD COLUMN IF NOT EXISTS processing_attempts INTEGER NOT NULL DEFAULT 0
    """)
    op.execute("""
        ALTER TABLE digital_prfs
        ADD COLUMN IF NOT EXISTS last_processing_at TIMESTAMPTZ
    """)

    # ══════════════════════════════════════════════════════════════════════
    # 3. Add index on status for fast filtering of failed PRFs
    # ══════════════════════════════════════════════════════════════════════
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_digital_prfs_status
        ON digital_prfs (status)
    """)


def downgrade() -> None:
    # Drop the status index
    op.execute("DROP INDEX IF EXISTS ix_digital_prfs_status")

    # Drop processing columns
    op.execute("ALTER TABLE digital_prfs DROP COLUMN IF EXISTS last_processing_at")
    op.execute("ALTER TABLE digital_prfs DROP COLUMN IF EXISTS processing_attempts")
    op.execute("ALTER TABLE digital_prfs DROP COLUMN IF EXISTS processing_error")

    # Remove 'FAILED' from the prf_status enum.
    # First, update any rows using 'FAILED' back to 'SUBMITTED'.
    op.execute("""
        UPDATE digital_prfs SET status = 'SUBMITTED' WHERE status = 'FAILED'
    """)

    # Recreate the enum without 'FAILED'
    op.execute("ALTER TYPE prf_status RENAME TO prf_status_old")
    op.execute("CREATE TYPE prf_status AS ENUM ('DRAFT', 'SUBMITTED', 'PROCESSED')")
    op.execute("""
        ALTER TABLE digital_prfs
        ALTER COLUMN status TYPE prf_status
        USING status::text::prf_status
    """)
    op.execute("DROP TYPE prf_status_old")

