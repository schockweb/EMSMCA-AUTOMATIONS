"""Scope idempotency keys to an actor, and make the table purgeable

The `Idempotency-Key` header was the PRIMARY KEY of a global table with no
tenant component, so two administrators sending the same header to the same
route collided — and the second was handed the FIRST's cached medical-scheme
response (authorisation number, member details, claim data) with no ownership
check. The key is now a hash of (actor, path, caller key).

Existing rows are DELETED rather than migrated. They are keyed under the old
global scheme, so they cannot be re-scoped to an owner that was never recorded,
and serving one to a future request is exactly the cross-tenant replay being
closed. They are also short-lived by design (24h) and purely an optimisation:
losing them costs at worst one duplicate-submission check.

Revision ID: b8e3f52a91c7
Revises: a4d81c6b2f75
Create Date: 2026-08-03
"""
from alembic import op

revision = "b8e3f52a91c7"
down_revision = "a4d81c6b2f75"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS scope VARCHAR(255)")
    op.execute("ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS path VARCHAR(255)")
    # The purge and the stale-lock reclaim both filter on age.
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_idempotency_keys_created_at "
        "ON idempotency_keys (created_at)"
    )
    # Old rows carry globally-scoped keys — see the note above.
    op.execute("DELETE FROM idempotency_keys")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_idempotency_keys_created_at")
    op.execute("ALTER TABLE idempotency_keys DROP COLUMN IF EXISTS path")
    op.execute("ALTER TABLE idempotency_keys DROP COLUMN IF EXISTS scope")
