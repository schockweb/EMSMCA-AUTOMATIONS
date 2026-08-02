"""Bulk session revocation — invalidate every token issued before a cutoff

The JTI blacklist can only revoke a token somebody has PRESENTED. That is the
wrong shape for the case that actually matters here: a token copied off a
device. Nobody has seen the copy, so there is no JTI to blacklist, and logging
out on the real device revokes the real device's token while the copy keeps
working for its full lifetime — 12 hours for a crew shift token, 7 days for an
admin refresh token.

A per-identity cutoff fixes that in one write. `tokens_revoked_at` invalidates
every credential issued to that identity before the timestamp, seen or unseen.

Three tables because there are three token families with three different
disaster stories:
  users             — a replayed refresh token means the credential was stolen
  crew_members      — a tablet left at the hospital, or handed to the wrong person
  service_providers — the shared company password leaked, and rotating it alone
                      does not kill the 12-hour device grants already minted
                      from the old one

Nullable with no default, so this migration changes nobody's session: NULL
means "nothing revoked" and every existing token keeps working.

Revision ID: e5a8c2d47f19
Revises: d1f7b93c6e40
Create Date: 2026-08-02
"""
from alembic import op

revision = "e5a8c2d47f19"
down_revision = "d1f7b93c6e40"
branch_labels = None
depends_on = None

# Idempotent ALTERs on purpose. The development database is create_all-managed
# rather than alembic-stamped, so these get hand-applied there; running the
# migration afterwards must not fail on a column that already exists.
_TABLES = ("users", "crew_members", "service_providers")


def upgrade() -> None:
    for table in _TABLES:
        op.execute(
            f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS "
            "tokens_revoked_at TIMESTAMP WITH TIME ZONE"
        )


def downgrade() -> None:
    for table in _TABLES:
        op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS tokens_revoked_at")
