"""Deactivating a client must be reversible to the state it was in

Replacing "Delete client" with "Deactivate client" needs one thing the schema
could not express: which crew members were switched off BY the company being
switched off.

Deactivation cascades to `crew_members.is_active = false`, otherwise the company
disappears from the portal while its individual paramedics can still start a
shift. Reactivation then has to put the crew back — but "set every crew member
of this provider active" is wrong, and wrong in the direction that matters: the
paramedic who left the service last year and was deactivated individually looks
identical to a cascaded one once both are just `is_active = false`. Reactivating
the company would hand that person a working login and access to patient
records.

`deactivated_with_provider` is written only by the cascade, so reactivation can
restore exactly the rows it turned off and leave individually-disabled leavers
alone.

Revision ID: b4e1c7f92a63
Revises: d5b7e91a3c62
Create Date: 2026-08-07
"""
from alembic import op

revision = "b4e1c7f92a63"
down_revision = "d5b7e91a3c62"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # IF NOT EXISTS rather than op.add_column: dev and fresh-install databases
    # are built by create_all from the models and then stamped at head, so this
    # column may already be present when the migration runs. A plain add_column
    # aborts the whole transaction in that case (see the notes on the audit
    # append-only trigger for the same fresh-install/migration split).
    op.execute(
        "ALTER TABLE crew_members "
        "ADD COLUMN IF NOT EXISTS deactivated_with_provider BOOLEAN "
        "NOT NULL DEFAULT FALSE"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE crew_members DROP COLUMN IF EXISTS deactivated_with_provider")
