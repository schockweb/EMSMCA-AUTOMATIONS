"""add_cases_dependant_code_column

Adds the `cases.dependant_code` column that the Case ORM model declares but
which is missing from databases bootstrapped before the field was introduced.

Migration `66bd72a732f9` only ran `alter_column` against `dependant_code`
(to set its comment), assuming the column already existed — so any database
that didn't have it from an earlier `Base.metadata.create_all()` bootstrap
ended up without the column, causing application startup to crash with:
    column cases.dependant_code does not exist

Uses ADD COLUMN IF NOT EXISTS so it's a no-op on databases that already have it.

Revision ID: d4e7f2c1a8b9
Revises: c8f5e9d2a1b3
Create Date: 2026-05-04
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'd4e7f2c1a8b9'
down_revision: Union[str, Sequence[str], None] = 'c8f5e9d2a1b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE cases ADD COLUMN IF NOT EXISTS dependant_code VARCHAR(5)"
    )
    op.execute(
        "COMMENT ON COLUMN cases.dependant_code IS "
        "'Scheme dependant code e.g. 00=principal, 01=spouse'"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE cases DROP COLUMN IF EXISTS dependant_code")
