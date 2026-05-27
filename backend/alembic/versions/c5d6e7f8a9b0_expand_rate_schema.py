"""Expand rate_schemas with time billing columns and active flag.

Revision ID: c5d6e7f8a9b0
Revises: b4c8d2e6f7a3
Create Date: 2026-05-26 15:10:00.000000

Adds:
  - rate_per_minute   NUMERIC(10,4) — per-minute billing rate
  - min_minutes       INTEGER       — minimum billable minutes
  - time_rounding     VARCHAR(20)   — rounding rule for minutes
  - time_basis        VARCHAR(30)   — which time segment is billable
  - active            BOOLEAN       — hard disable flag
  - Renames rounding_rule → km_rounding
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "c5d6e7f8a9b0"
down_revision = "b4c8d2e6f7a3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── New columns for time-based billing ──
    op.execute("""
        ALTER TABLE rate_schemas
        ADD COLUMN IF NOT EXISTS rate_per_minute NUMERIC(10,4) NOT NULL DEFAULT 0
    """)
    op.execute("""
        ALTER TABLE rate_schemas
        ADD COLUMN IF NOT EXISTS min_minutes INTEGER NOT NULL DEFAULT 0
    """)
    op.execute("""
        ALTER TABLE rate_schemas
        ADD COLUMN IF NOT EXISTS time_rounding VARCHAR(20) NOT NULL DEFAULT 'none'
    """)
    op.execute("""
        ALTER TABLE rate_schemas
        ADD COLUMN IF NOT EXISTS time_basis VARCHAR(30) NOT NULL DEFAULT 'dispatch_to_clear'
    """)
    op.execute("""
        ALTER TABLE rate_schemas
        ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE
    """)

    # ── Rename rounding_rule → km_rounding for clarity ──
    # Check if old column exists before renaming (idempotent)
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'rate_schemas' AND column_name = 'rounding_rule'
            ) THEN
                ALTER TABLE rate_schemas RENAME COLUMN rounding_rule TO km_rounding;
            END IF;
        END $$;
    """)


def downgrade() -> None:
    # Rename back
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'rate_schemas' AND column_name = 'km_rounding'
            ) THEN
                ALTER TABLE rate_schemas RENAME COLUMN km_rounding TO rounding_rule;
            END IF;
        END $$;
    """)

    # Drop added columns
    op.execute("ALTER TABLE rate_schemas DROP COLUMN IF EXISTS rate_per_minute")
    op.execute("ALTER TABLE rate_schemas DROP COLUMN IF EXISTS min_minutes")
    op.execute("ALTER TABLE rate_schemas DROP COLUMN IF EXISTS time_rounding")
    op.execute("ALTER TABLE rate_schemas DROP COLUMN IF EXISTS time_basis")
    op.execute("ALTER TABLE rate_schemas DROP COLUMN IF EXISTS active")
