"""Add cases.custom_display_name

Revision ID: d5a8c2f1b6e3
Revises: c3f7a1b9e4d2
Create Date: 2026-07-15 12:00:00.000000

Manual rename override for the PRF list name (Case Management rename dialog).
Written tolerant of prod schema state: dev DBs are create_all-managed (column
may already exist), prod is alembic-driven (column absent). ADD/DROP ...
IF [NOT] EXISTS lets both converge without error.
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'd5a8c2f1b6e3'
down_revision: Union[str, Sequence[str], None] = 'c3f7a1b9e4d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE cases ADD COLUMN IF NOT EXISTS custom_display_name VARCHAR(255)"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE cases DROP COLUMN IF EXISTS custom_display_name"
    )
