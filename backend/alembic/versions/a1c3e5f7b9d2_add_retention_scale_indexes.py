"""Add retention-scale indexes (7-year PRF history)

Revision ID: a1c3e5f7b9d2
Revises: a9d4e2c7b1f8
Create Date: 2026-07-21 00:00:00.000000

PRFs and cases are retained for 7 years (HPCSA / POPIA medical-legal record
requirement). Over that span these tables grow large, and the hot list/search
queries filter/sort on unindexed columns — a full-table scan that degrades as
history accumulates. These indexes keep the provider dashboard and the case
list fast at 7-year scale:

  * digital_prfs.provider_id — the provider dashboard filters EVERY query by it
  * cases.created_at         — the case list orders by created_at DESC + paginates

IF NOT EXISTS keeps this safe on dev nodes where the columns already exist via
create_all. Tables are small pre-go-live so a plain CREATE INDEX is instant;
once a table holds millions of rows, prefer CREATE INDEX CONCURRENTLY (which
must run outside a transaction, so apply it by hand rather than via this
migration).
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'a1c3e5f7b9d2'
down_revision: Union[str, Sequence[str], None] = 'a9d4e2c7b1f8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_digital_prfs_provider_id "
        "ON digital_prfs (provider_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_cases_created_at "
        "ON cases (created_at)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_cases_created_at")
    op.execute("DROP INDEX IF EXISTS ix_digital_prfs_provider_id")
