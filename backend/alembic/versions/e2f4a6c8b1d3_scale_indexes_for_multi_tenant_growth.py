"""Scale indexes for multi-tenant growth

Revision ID: e2f4a6c8b1d3
Revises: c7d9e1f3a5b8
Create Date: 2026-07-31

Twelve indexes on columns that are filtered, joined or sorted on every hot path
and had no index at all. They are created NOW, while the tables are still small,
because doing it later is a genuinely different and worse operation.

The retention-index migration a1c3e5f7b9d2 already says why, in its own words:

    "once a table holds millions of rows, prefer CREATE INDEX CONCURRENTLY
     (which must run outside a transaction, so apply it by hand rather than via
     this migration)"

A plain CREATE INDEX takes an ACCESS EXCLUSIVE lock for its duration — on an
empty table that is milliseconds, on a multi-million-row table it is an outage
of a live medical records system. Every index skipped today becomes a manual,
out-of-band operation on production later. Production currently holds 99 PRFs,
so this is as cheap as it will ever be.

Measured impact of just one of them (digital_prfs.case_id) on a 3M-row mirror:
1021-1259ms -> 1.4-5.3ms, for an 80MB index.

Each statement is IF NOT EXISTS: several of these are also declared on the ORM
models now, so a database built by bootstrap_schema.py already has them and must
not error here. The two paths are deliberately kept in agreement — the reason
digital_prfs.correction_of_id was missing on fresh installs is that it existed
ONLY as raw SQL inside migration d6e7f8a9b0c1 and was never declared on the
model.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "e2f4a6c8b1d3"
down_revision: Union[str, Sequence[str], None] = "c7d9e1f3a5b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (index name, table, column expression)
_INDEXES = [
    # Joined on every /api/cases list, get and patch to attach the PRF.
    ("ix_digital_prfs_case_id", "digital_prfs", "case_id"),
    # Filtered on EVERY PRF creation by _next_prf_number (correction_of_id IS NULL).
    ("ix_digital_prfs_correction_of_id", "digital_prfs", "correction_of_id"),
    # Tenant-isolation filters on the shift-start and provider-admin paths.
    ("ix_crew_members_provider_id", "crew_members", "provider_id"),
    ("ix_vehicles_provider_id", "vehicles", "provider_id"),
    # FKs to users. Unindexed FKs also slow every DELETE on the parent row.
    ("ix_documents_uploaded_by", "documents", "uploaded_by"),
    ("ix_cases_assigned_provider_id", "cases", "assigned_provider_id"),
    # Back the analytics aggregates and /api/stats, which currently issue
    # dozens of COUNT/SUM statements filtered on exactly these columns.
    ("ix_documents_ocr_status", "documents", "ocr_status"),
    ("ix_documents_created_at", "documents", "created_at"),
    ("ix_claims_adjudication_status", "claims", "adjudication_status"),
    ("ix_claims_created_at", "claims", "created_at"),
    ("ix_rfis_rfi_status", "rfis", "rfi_status"),
    ("ix_edi_submissions_submission_status", "edi_submissions", "submission_status"),
]

# The provider dashboard's default sort. It is an EXPRESSION sort
# (coalesce(submitted_at, created_at) DESC), so a plain column index cannot
# cover it — see app/api/providers.py list_provider_prfs.
_PROVIDER_PRF_SORT = (
    "ix_digital_prfs_provider_recent",
    "digital_prfs",
    "(provider_id, coalesce(submitted_at, created_at) DESC)",
)


def upgrade() -> None:
    for name, table, column in _INDEXES:
        op.execute(f'CREATE INDEX IF NOT EXISTS {name} ON {table} ({column})')

    name, table, expr = _PROVIDER_PRF_SORT
    op.execute(f"CREATE INDEX IF NOT EXISTS {name} ON {table} {expr}")


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {_PROVIDER_PRF_SORT[0]}")
    for name, _table, _column in reversed(_INDEXES):
        op.execute(f"DROP INDEX IF EXISTS {name}")
