"""Add scheme_tariff_lines table for DB-driven tariff billing.

Revision ID: e1f2a3b4c5d6
Revises: d6e7f8a9b0c1
Create Date: 2026-05-27

Each row represents one tariff code + rate entry for a medical scheme.
This lets schemes beyond GEMS/Discovery be fully priced from the admin UI
without requiring a code deployment.
"""

from alembic import op

revision = "e1f2a3b4c5d6"
down_revision = "d6e7f8a9b0c1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS scheme_tariff_lines (
            id              SERIAL PRIMARY KEY,
            rate_schema_id  INTEGER NOT NULL
                            REFERENCES rate_schemas(id) ON DELETE CASCADE,
            tariff_code     VARCHAR(30) NOT NULL,
            description     TEXT NOT NULL,
            category        VARCHAR(30) NOT NULL DEFAULT 'base_rate',
            level_of_care   VARCHAR(10),
            loaded          BOOLEAN,
            primary_rate    NUMERIC(10,2) NOT NULL DEFAULT 0,
            iht_rate        NUMERIC(10,2) NOT NULL DEFAULT 0,
            unit            VARCHAR(30) NOT NULL DEFAULT 'per call',
            keywords        TEXT,
            is_active       BOOLEAN NOT NULL DEFAULT TRUE,
            notes           TEXT,
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            updated_at      TIMESTAMPTZ,
            UNIQUE(rate_schema_id, tariff_code)
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_scheme_tariff_lines_schema_id
        ON scheme_tariff_lines (rate_schema_id)
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS scheme_tariff_lines")
