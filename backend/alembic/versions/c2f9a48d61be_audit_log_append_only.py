"""Make audit_logs append-only in fact, not only in a docstring

The model calls it an "Immutable, append-only POPIA compliance ledger". Nothing
enforced any part of that: the application's own database role held UPDATE and
DELETE, so anyone who reached the credentials in .env — which sit on the same VM
as nginx — could erase their own trail from the record of who opened which
patient's file.

A BEFORE UPDATE OR DELETE trigger refuses both, unless the session has
deliberately opted out by setting `ems.audit_maintenance = 'on'`.

WHAT THIS DOES AND DOES NOT DO — read before quoting it to anyone.

  It DOES stop: application code deleting or rewriting audit rows, whether by
  bug, by a careless new feature, or by someone with app credentials who does
  not know the escape hatch exists. That is the realistic failure mode and it is
  now blocked by the database rather than by convention.

  It does NOT make the table tamper-PROOF. A party with the app's database
  credentials can set the escape flag, and a superuser can drop the trigger.
  Genuine tamper-evidence needs the application role to lack DELETE entirely
  (a separate migration role), or the entries shipped off-box to append-only
  storage. Both are worth doing; neither is done here.

The escape hatch is deliberate rather than an oversight. Test fixtures clean up
their own rows, and a lawful erasure order has to be executable by someone. The
point is that it must be an explicit, visible act — `SET LOCAL` in the same
transaction — and never something that happens by accident.

Revision ID: c2f9a48d61be
Revises: b8e3f52a91c7
Create Date: 2026-08-03
"""
from alembic import op

revision = "c2f9a48d61be"
down_revision = "b8e3f52a91c7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE OR REPLACE FUNCTION ems_audit_logs_append_only()
        RETURNS TRIGGER AS $$
        BEGIN
            IF coalesce(current_setting('ems.audit_maintenance', true), '') = 'on' THEN
                RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
            END IF;
            RAISE EXCEPTION
                'audit_logs is append-only: % is not permitted. This table is the '
                'record of who accessed which patient file. If this really is '
                'authorised maintenance, the session must opt in explicitly with '
                'SET LOCAL ems.audit_maintenance = ''on'' in the same transaction.',
                TG_OP
                USING ERRCODE = 'insufficient_privilege';
        END;
        $$ LANGUAGE plpgsql;
    """)
    op.execute("DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON audit_logs")
    op.execute("""
        CREATE TRIGGER trg_audit_logs_append_only
        BEFORE UPDATE OR DELETE ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION ems_audit_logs_append_only();
    """)
    # The read API filters by actor, entity and date; without these it would
    # sequential-scan the fastest-growing table in the system.
    op.execute("CREATE INDEX IF NOT EXISTS ix_audit_logs_created_at ON audit_logs (created_at DESC)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_audit_logs_action ON audit_logs (action)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_audit_logs_entity ON audit_logs (entity_type, entity_id)")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON audit_logs")
    op.execute("DROP FUNCTION IF EXISTS ems_audit_logs_append_only()")
    op.execute("DROP INDEX IF EXISTS ix_audit_logs_entity")
    op.execute("DROP INDEX IF EXISTS ix_audit_logs_action")
    op.execute("DROP INDEX IF EXISTS ix_audit_logs_created_at")
