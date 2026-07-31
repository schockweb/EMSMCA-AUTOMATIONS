"""Crash event aggregation counter

Revision ID: f3a5c7e9d2b4
Revises: e2f4a6c8b1d3
Create Date: 2026-07-31

POST /api/crashes is unauthenticated by design — a crash must be reportable when
authentication is exactly what is broken — and wrote ONE ROW PER CALL with no
aggregation and no cap. The frontend fires it from window.onerror,
onunhandledrejection and on every 5xx from the shared axios client, so the flood
peaks precisely when the backend is already unhealthy.

The development database reached 3.68 MILLION crash rows in 27 days — 99.2% of
the entire database — of which 3,679,048 were the same message, peaking at 8,166
rows per minute. Production currently holds 76 rows only because it has a single
user; the mechanism is identical and scales with user count.

These two columns let a repeated fault increment a counter instead of authoring
a new row, so the table grows with DISTINCT faults rather than with occurrences.

The supporting index covers the lookup the endpoint now performs on every report
(source + error_type + endpoint within the last hour). Without it, the
deduplication read would itself become a sequential scan of the very table it
exists to keep small.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f3a5c7e9d2b4"
down_revision: Union[str, Sequence[str], None] = "e2f4a6c8b1d3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE crash_events "
        "ADD COLUMN IF NOT EXISTS occurrences INTEGER NOT NULL DEFAULT 1"
    )
    op.execute(
        "ALTER TABLE crash_events "
        "ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NULL"
    )
    # Backfill: every pre-existing row represents exactly one occurrence, and
    # its created_at is the only timestamp we have for it.
    op.execute(
        "UPDATE crash_events SET last_seen_at = created_at WHERE last_seen_at IS NULL"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_crash_events_dedup "
        "ON crash_events (source, error_type, endpoint, created_at DESC)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_crash_events_dedup")
    op.execute("ALTER TABLE crash_events DROP COLUMN IF EXISTS last_seen_at")
    op.execute("ALTER TABLE crash_events DROP COLUMN IF EXISTS occurrences")
