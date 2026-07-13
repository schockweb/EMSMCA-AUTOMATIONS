"""Per-provider PRF numbering

Revision ID: f4b9c1d7e2a8
Revises: 283026c60d1d
Create Date: 2026-07-13 00:00:00.000000

Switches PRF numbering from one global sequence shared by every provider to an
independent counter per provider, and adds the admin-set `prf_start_number`
onboarding baseline that seeds each provider's count.

Prod-tolerant: `digital_prfs` is created by SQLAlchemy `create_all`, so the old
GLOBAL uniqueness on `prf_number` may be either a UNIQUE constraint
(`digital_prfs_prf_number_key`) or a unique index (`ix_digital_prfs_prf_number`)
depending on how each environment's DB was built. Both are dropped with
IF EXISTS so dev and prod converge. Existing rows keep their numbers — global
uniqueness guarantees the new (provider_id, prf_number) pairs are already
unique, so the composite index builds without conflict.
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'f4b9c1d7e2a8'
down_revision: Union[str, Sequence[str], None] = '283026c60d1d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Onboarding baseline. IF NOT EXISTS keeps this safe on prod nodes that
    #    ran create_all (adding the column from the new model) before migrating.
    op.execute(
        "ALTER TABLE service_providers "
        "ADD COLUMN IF NOT EXISTS prf_start_number INTEGER"
    )

    # 2. Drop the old GLOBAL uniqueness on prf_number — constraint first (in
    #    case an env backs it with a named constraint), then any unique index.
    op.execute("ALTER TABLE digital_prfs DROP CONSTRAINT IF EXISTS digital_prfs_prf_number_key")
    op.execute("DROP INDEX IF EXISTS ix_digital_prfs_prf_number")

    # 3. Per-provider uniqueness. A unique index enforces the same rule as the
    #    model's UniqueConstraint while staying idempotent via IF NOT EXISTS.
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_digital_prf_provider_number "
        "ON digital_prfs (provider_id, prf_number)"
    )

    # 4. Restore a plain (non-unique) lookup index on prf_number — the model
    #    still declares index=True, just no longer globally unique.
    op.execute("CREATE INDEX IF NOT EXISTS ix_digital_prfs_prf_number ON digital_prfs (prf_number)")

    # 5. Retire the now-unused global sequence if a prior deploy created it.
    op.execute("DROP SEQUENCE IF EXISTS prf_number_seq")


def downgrade() -> None:
    # Reverting to global uniqueness could fail if two providers now share a
    # prf_number, so we only restore a plain index and drop the new objects.
    op.execute("DROP INDEX IF EXISTS uq_digital_prf_provider_number")
    op.execute("DROP INDEX IF EXISTS ix_digital_prfs_prf_number")
    op.execute("CREATE INDEX IF NOT EXISTS ix_digital_prfs_prf_number ON digital_prfs (prf_number)")
    op.execute("ALTER TABLE service_providers DROP COLUMN IF EXISTS prf_start_number")
