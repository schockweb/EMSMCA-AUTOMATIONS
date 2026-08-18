"""service_providers.phone — VARCHAR(20) -> VARCHAR(100)

Revision ID: e2b4c17d9f36
Revises: a1c4e8b73f52
Create Date: 2026-08-18

Clients list two contact numbers on the PRF letterhead. "011 123 4567 /
082 555 1234" is 27 characters, so at 20 the onboarding form silently capped
what could be typed and the edit dialog (which had no cap) got a 422 back.

Widening a VARCHAR is not a rewrite in PostgreSQL — it is a catalog update, no
table scan, no lock held for the length of the data. Safe on a live prod table.

Idempotent, because this repo has three kinds of database in the wild:
alembic-managed production, a create_all-managed dev box where the column may
already be the new width, and fresh installs built by bootstrap_schema.py from
Base.metadata and then stamped at head WITHOUT running migrations. Only the
first of those actually executes this file.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "e2b4c17d9f36"
down_revision: Union[str, Sequence[str], None] = "a1c4e8b73f52"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'service_providers'
                   AND column_name = 'phone'
                   AND character_maximum_length < 100
            ) THEN
                ALTER TABLE service_providers
                    ALTER COLUMN phone TYPE VARCHAR(100);
            END IF;
        END $$
        """
    )


def downgrade() -> None:
    # Narrowing back WOULD scan and would fail outright on any row already
    # holding two numbers, so the longer values are truncated first. Widening
    # is the safe direction; this exists only so the revision is reversible.
    op.execute("UPDATE service_providers SET phone = LEFT(phone, 20) WHERE LENGTH(phone) > 20")
    op.execute("ALTER TABLE service_providers ALTER COLUMN phone TYPE VARCHAR(20)")
