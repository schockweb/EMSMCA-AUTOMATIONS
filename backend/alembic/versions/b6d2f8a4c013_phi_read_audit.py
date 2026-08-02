"""PHI read audit — crew actor column and the indexes breach scoping needs

Nothing has ever logged a READ of a patient record. POPIA s22 requires notifying
the Regulator and every affected data subject when personal information may have
been accessed by an unauthorised person, and answering "which patients?" is
impossible without a read trail — so the honest answer would have been "all of
them".

This adds:
  * audit_logs.crew_member_id — crew are not users, and crew perform almost
    every clinical read, so the existing user_id FK could not name the actor.
  * the indexes the two investigation queries need:
      "who touched this record?"      -> (entity_type, entity_id)
      "what did this account touch?"  -> (crew_member_id) / (user_id, existing)
      "what happened in this window?" -> (action, created_at DESC)

Every statement is idempotent: this database is create_all-managed in
development and migrations are applied by hand in production, so a re-run must
be harmless.

Revision ID: b6d2f8a4c013
Revises: f3a5c7e9d2b4
Create Date: 2026-08-02
"""
from alembic import op

revision = "b6d2f8a4c013"
down_revision = "f3a5c7e9d2b4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS crew_member_id UUID"
    )
    # Separate statement, and guarded: the column may already exist from a
    # create_all run without the constraint.
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'fk_audit_logs_crew_member_id'
            ) THEN
                ALTER TABLE audit_logs
                    ADD CONSTRAINT fk_audit_logs_crew_member_id
                    FOREIGN KEY (crew_member_id) REFERENCES crew_members(id);
            END IF;
        END $$;
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_audit_logs_crew_member_id "
        "ON audit_logs (crew_member_id)"
    )
    # "Who accessed this patient's record?" — the primary breach-scoping query.
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_audit_logs_entity "
        "ON audit_logs (entity_type, entity_id)"
    )
    # "What happened between these times?" — partial, because READ/TRANSMIT will
    # dominate the table and the incident questions are always about those two.
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_audit_logs_access_created "
        "ON audit_logs (created_at DESC) WHERE action IN ('READ', 'TRANSMIT')"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_audit_logs_access_created")
    op.execute("DROP INDEX IF EXISTS ix_audit_logs_entity")
    op.execute("DROP INDEX IF EXISTS ix_audit_logs_crew_member_id")
    op.execute("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS fk_audit_logs_crew_member_id")
    op.execute("ALTER TABLE audit_logs DROP COLUMN IF EXISTS crew_member_id")
