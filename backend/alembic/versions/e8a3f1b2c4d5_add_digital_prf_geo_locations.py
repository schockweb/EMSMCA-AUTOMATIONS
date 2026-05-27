"""add_digital_prf_geo_locations

Adds the `digital_prfs.geo_locations` JSONB column. Stores GPS coordinates
captured by the crew when they tap each "Mark Time" button, keyed by the
timestamp field name (e.g. "time_dispatched").

Revision ID: e8a3f1b2c4d5
Revises: d4e7f2c1a8b9
Create Date: 2026-05-07
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'e8a3f1b2c4d5'
down_revision: Union[str, Sequence[str], None] = 'd4e7f2c1a8b9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE digital_prfs "
        "ADD COLUMN IF NOT EXISTS geo_locations JSONB DEFAULT '{}'::jsonb"
    )
    op.execute(
        "COMMENT ON COLUMN digital_prfs.geo_locations IS "
        "'GPS coordinates captured when crew marks each timestamp, keyed by field name'"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE digital_prfs DROP COLUMN IF EXISTS geo_locations")
