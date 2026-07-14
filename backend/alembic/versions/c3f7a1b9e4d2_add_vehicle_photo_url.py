"""Add vehicles.photo_url

Revision ID: c3f7a1b9e4d2
Revises: b2e6f9c3a7d1
Create Date: 2026-07-14 12:00:00.000000

Adds the ambulance photo URL column (mirror of crew_members.photo_url). Written
tolerant of prod schema state: dev DBs are create_all-managed (column may already
exist), prod is alembic-driven (column absent). ADD/DROP ... IF [NOT] EXISTS lets
both converge without error.
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'c3f7a1b9e4d2'
down_revision: Union[str, Sequence[str], None] = 'b2e6f9c3a7d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500)"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE vehicles DROP COLUMN IF EXISTS photo_url"
    )
