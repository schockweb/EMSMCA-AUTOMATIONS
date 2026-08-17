"""crew_shifts — vehicle occupancy for the shift-start warning

Revision ID: a1c4e8b73f52
Revises: b4e1c7f92a63
Create Date: 2026-08-17

Adds the table behind "ALPHA 12 is already in use" on the shift-start picker.
Advisory only: nothing here blocks a shift, it just gives the next crew
something to see. See app/models/crew_shift.py for why it is not a lock.

Written idempotently (IF NOT EXISTS throughout) because this repo has three
kinds of database in the wild: alembic-managed production, a create_all-managed
dev box where the table may already exist from a container restart, and fresh
installs built by bootstrap_schema.py from Base.metadata and then stamped at
head WITHOUT running migrations. Only the first of those actually executes this
file, and it must not fail on either of the others if someone does run it.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "a1c4e8b73f52"
down_revision: Union[str, Sequence[str], None] = "b4e1c7f92a63"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS crew_shifts (
            id                UUID PRIMARY KEY,
            provider_id       UUID NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
            crew_member_id    UUID NOT NULL REFERENCES crew_members(id)      ON DELETE CASCADE,
            vehicle_id        UUID NOT NULL REFERENCES vehicles(id)          ON DELETE CASCADE,
            vehicle_callsign  VARCHAR(50),
            crew_name         VARCHAR(200),
            partner_name      VARCHAR(200),
            started_at        TIMESTAMPTZ NOT NULL,
            ended_at          TIMESTAMPTZ,
            ended_reason      VARCHAR(20)
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_crew_shifts_provider_id ON crew_shifts (provider_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_crew_shifts_crew_member_id ON crew_shifts (crew_member_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_crew_shifts_vehicle_id ON crew_shifts (vehicle_id)")
    # The occupancy lookup. Partial, because within days of go-live almost every
    # row is a closed shift and this query never reads one.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_crew_shifts_vehicle_open
            ON crew_shifts (vehicle_id, started_at)
         WHERE ended_at IS NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS crew_shifts")
