"""Add crew_members.photo_url

Revision ID: b2e6f9c3a7d1
Revises: f4b9c1d7e2a8
Create Date: 2026-07-14 09:00:00.000000

Adds the crew face-photo URL column. Written tolerant of prod schema state:
dev DBs are create_all-managed (column may already exist), prod is alembic-driven
(column absent). ADD/DROP ... IF [NOT] EXISTS lets both converge without error.
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'b2e6f9c3a7d1'
down_revision: Union[str, Sequence[str], None] = 'f4b9c1d7e2a8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE crew_members ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500)"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE crew_members DROP COLUMN IF EXISTS photo_url"
    )
