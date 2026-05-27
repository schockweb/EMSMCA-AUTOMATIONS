"""billing_critical_fixes

Phase 1 billing-critical schema changes:

1. Convert 9 KM odometer columns from varchar(10) → numeric(8,1).
   Legacy data is cleaned first (strip whitespace, comma→dot, empty→NULL)
   then cast via USING. CHECK constraints enforce 0–999999.9.

2. Add `review_flags` JSONB column (default '[]') with a GIN index.
   Stores machine- or human-generated review flags per PRF.

3. Add `billing_schema_code` varchar(50) column (nullable, indexed).
   Links a PRF to its applicable rate schema for billing.

4. Create `rate_schemas` table — stores per-scheme tariff configuration
   (rate per km, base fee, multipliers, rounding rules, etc.).

Revision ID: a3b7c9d1e5f2
Revises: f2c5b9d8e3a1
Create Date: 2026-05-25
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'a3b7c9d1e5f2'
down_revision: Union[str, Sequence[str], None] = 'f2c5b9d8e3a1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# The 9 KM odometer columns to convert
KM_COLUMNS = [
    "km_call_received",
    "km_dispatched",
    "km_mobile",
    "km_on_scene",
    "km_depart_scene",
    "km_at_destination",
    "km_handover",
    "km_available",
    "km_back_to_base",
]


def upgrade() -> None:
    # ══════════════════════════════════════════════════════════════════════
    # 1. Convert KM columns: varchar(10) → numeric(8,1)
    # ══════════════════════════════════════════════════════════════════════

    # 1a. Clean existing data in-place (still varchar at this point)
    for col in KM_COLUMNS:
        op.execute(f"""
            UPDATE digital_prfs
            SET {col} = NULLIF(TRIM(REPLACE({col}::TEXT, ',', '.')), '')::NUMERIC
            WHERE {col} IS NOT NULL
        """)

    # 1b. ALTER COLUMN TYPE with USING cast
    for col in KM_COLUMNS:
        op.execute(f"""
            ALTER TABLE digital_prfs
            ALTER COLUMN {col}
            TYPE NUMERIC(8, 1)
            USING {col}::NUMERIC(8, 1)
        """)

    # 1c. Add CHECK constraints (>= 0 AND <= 999999.9)
    for col in KM_COLUMNS:
        op.execute(f"""
            UPDATE digital_prfs
            SET {col} = NULL
            WHERE {col} < 0 OR {col} > 999999.9
        """)
        op.execute(f"""
            ALTER TABLE digital_prfs
            ADD CONSTRAINT chk_{col}_range
            CHECK ({col} >= 0 AND {col} <= 999999.9)
        """)

    # ══════════════════════════════════════════════════════════════════════
    # 2. Add review_flags JSONB column
    # ══════════════════════════════════════════════════════════════════════
    op.execute("""
        ALTER TABLE digital_prfs
        ADD COLUMN IF NOT EXISTS review_flags JSONB NOT NULL DEFAULT '[]'::jsonb
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_digital_prfs_review_flags
        ON digital_prfs USING GIN (review_flags)
    """)

    # ══════════════════════════════════════════════════════════════════════
    # 3. Add billing_schema_code column
    # ══════════════════════════════════════════════════════════════════════
    op.execute("""
        ALTER TABLE digital_prfs
        ADD COLUMN IF NOT EXISTS billing_schema_code VARCHAR(50)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_digital_prfs_billing_schema_code
        ON digital_prfs (billing_schema_code)
    """)

    # ══════════════════════════════════════════════════════════════════════
    # 4. Create rate_schemas table
    # ══════════════════════════════════════════════════════════════════════
    op.execute("""
        CREATE TABLE IF NOT EXISTS rate_schemas (
            id              SERIAL PRIMARY KEY,
            schema_code     VARCHAR(50)   NOT NULL UNIQUE,
            scheme_name     VARCHAR(200)  NOT NULL,
            effective_from  DATE          NOT NULL,
            effective_to    DATE,
            rate_per_km     NUMERIC(10,2) NOT NULL,
            base_fee        NUMERIC(10,2) NOT NULL DEFAULT 0,
            minimum_km      NUMERIC(6,1)  NOT NULL DEFAULT 0,
            rounding_rule   VARCHAR(20)   NOT NULL DEFAULT 'nearest',
            after_hours_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.0,
            weekend_multiplier     NUMERIC(4,2) NOT NULL DEFAULT 1.0,
            notes           TEXT,
            created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ,

            CONSTRAINT chk_rounding_rule
                CHECK (rounding_rule IN ('nearest', 'up', 'down')),
            CONSTRAINT chk_effective_range
                CHECK (effective_to IS NULL OR effective_to >= effective_from)
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_rate_schemas_schema_code
        ON rate_schemas (schema_code)
    """)


def downgrade() -> None:
    # Drop rate_schemas table
    op.execute("DROP TABLE IF EXISTS rate_schemas")

    # Drop billing_schema_code column
    op.execute("DROP INDEX IF EXISTS ix_digital_prfs_billing_schema_code")
    op.execute("ALTER TABLE digital_prfs DROP COLUMN IF EXISTS billing_schema_code")

    # Drop review_flags column
    op.execute("DROP INDEX IF EXISTS ix_digital_prfs_review_flags")
    op.execute("ALTER TABLE digital_prfs DROP COLUMN IF EXISTS review_flags")

    # Revert KM columns back to varchar(10)
    for col in KM_COLUMNS:
        op.execute(f"""
            ALTER TABLE digital_prfs
            DROP CONSTRAINT IF EXISTS chk_{col}_range
        """)
        op.execute(f"""
            ALTER TABLE digital_prfs
            ALTER COLUMN {col}
            TYPE VARCHAR(10)
            USING {col}::TEXT
        """)
