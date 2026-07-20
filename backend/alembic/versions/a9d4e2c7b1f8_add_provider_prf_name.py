"""Add service_providers.prf_name

Revision ID: a9d4e2c7b1f8
Revises: d5a8c2f1b6e3
Create Date: 2026-07-20 00:00:00.000000

Admin-chosen prefix for PRF file/display names. When set, it replaces the
automatic provider-name prefix in the exported-PDF filename
(buildPrfFileName in PRFView.tsx) and the canonical PRF display name
(_prf_display_name in api/cases.py). NULL keeps the automatic naming.
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'a9d4e2c7b1f8'
down_revision: Union[str, Sequence[str], None] = 'd5a8c2f1b6e3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # IF NOT EXISTS keeps this safe on dev nodes where create_all (or a
    # hand-applied ALTER) already added the column from the new model.
    op.execute(
        "ALTER TABLE service_providers "
        "ADD COLUMN IF NOT EXISTS prf_name VARCHAR(100)"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE service_providers DROP COLUMN IF EXISTS prf_name")
