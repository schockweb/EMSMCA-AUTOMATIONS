"""drop_deprecated_config_tables

Drops the DB-driven rule/config tables that have been replaced by hardcoded
Python modules under `backend/app/rules/` and environment variables for
scheme API credentials.

Tables dropped:
  scheme_rules              → replaced by app/rules/<scheme>.py::RULES
  billing_guidelines        → replaced by app/rules/<scheme>.py::TARIFFS/EXCLUSIONS/PREAUTH
  gems_tariffs              → replaced by app/rules/gems.py::TARIFFS
  extraction_corrections    → removed (OCR learning loop retired)
  scheme_configs            → replaced by SCHEME_<ID>_* env vars

Rows cleaned from system_settings:
  rfi_settings, communication_templates, extraction_settings,
  scheme_api, auth_rules

The `system_settings` table itself is retained — it may be reused for
future feature flags.

This migration is irreversible. Before applying in production, run:
    pg_dump -t scheme_rules -t billing_guidelines -t gems_tariffs \\
            -t extraction_corrections -t scheme_configs \\
            > pre_drop_config_backup.sql

Revision ID: c8f5e9d2a1b3
Revises: 74e6da76b622
Create Date: 2026-04-24
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'c8f5e9d2a1b3'
down_revision: Union[str, Sequence[str], None] = '74e6da76b622'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Drop tables (order respects FK dependencies — none of these have incoming FKs)
    op.execute("DROP TABLE IF EXISTS scheme_rules CASCADE")
    op.execute("DROP TABLE IF EXISTS billing_guidelines CASCADE")
    op.execute("DROP TABLE IF EXISTS gems_tariffs CASCADE")
    op.execute("DROP TABLE IF EXISTS extraction_corrections CASCADE")
    op.execute("DROP TABLE IF EXISTS scheme_configs CASCADE")

    # Drop orphaned enum types created by the above tables
    for enum_name in [
        "rule_type",
        "rule_severity",
        "tariff_category",
        "guideline_type",
        "guideline_status",
    ]:
        op.execute(f"DROP TYPE IF EXISTS {enum_name}")

    # Remove deprecated rows from system_settings (keep the table for future use)
    op.execute("""
        DELETE FROM system_settings
        WHERE category IN (
            'rfi_settings',
            'communication_templates',
            'extraction_settings',
            'scheme_api',
            'authorization_rules',
            'auth_rules'
        )
    """)


def downgrade() -> None:
    """Irreversible — recreating dropped schema would require restoring the
    ORM models we've just deleted. Restore from the pre-migration pg_dump if
    rollback is required."""
    raise NotImplementedError(
        "drop_deprecated_config_tables is irreversible. "
        "Restore scheme_rules, billing_guidelines, gems_tariffs, "
        "extraction_corrections, and scheme_configs from the pre-migration "
        "pg_dump artifact archived with the release tag."
    )
