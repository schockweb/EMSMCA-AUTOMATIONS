"""System fault register — detected conditions, proposed fixes, approvals

`crash_events` records what THREW. Most of the ways this platform actually fails
throw nothing: beat publishing to a queue no worker consumes, a migration that
was never applied, nginx holding a stale upstream address while the backend
reports healthy. This table is the other half.

Revision ID: f7c1a9e35b84
Revises: e5a8c2d47f19
Create Date: 2026-08-03
"""
from alembic import op

revision = "f7c1a9e35b84"
down_revision = "e5a8c2d47f19"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Enums created defensively: the development database is create_all-managed
    # rather than alembic-stamped, so SQLAlchemy may have created these already.
    op.execute("""
        DO $$ BEGIN
            CREATE TYPE fault_severity AS ENUM ('CRITICAL','HIGH','MEDIUM','LOW');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    """)
    op.execute("""
        DO $$ BEGIN
            CREATE TYPE fault_status AS ENUM (
                'DETECTED','AUTO_HEALED','AWAITING_APPROVAL','RESOLVED',
                'REMEDY_FAILED','DISMISSED','CLEARED');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS system_faults (
            id                 UUID PRIMARY KEY,
            fault_key          VARCHAR(100) NOT NULL,
            title              VARCHAR(255) NOT NULL,
            severity           fault_severity NOT NULL,
            status             fault_status NOT NULL DEFAULT 'DETECTED',
            evidence           JSON,
            remedy_key         VARCHAR(100),
            remedy_description TEXT,
            auto_eligible      BOOLEAN NOT NULL DEFAULT FALSE,
            decision_reason    TEXT,
            attempts           INTEGER NOT NULL DEFAULT 0,
            occurrences        INTEGER NOT NULL DEFAULT 1,
            first_seen_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            last_seen_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            last_attempt_at    TIMESTAMP WITH TIME ZONE,
            resolved_at        TIMESTAMP WITH TIME ZONE,
            approved_by        UUID REFERENCES users(id),
            approved_at        TIMESTAMP WITH TIME ZONE,
            outcome            TEXT
        )
    """)

    # The folding lookup: "is there an open row for this key". Every sweep runs
    # it once per probe, so it is the hottest query this table has.
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_system_faults_open
        ON system_faults (fault_key, status)
    """)
    # The operator's queue, newest first.
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_system_faults_status_seen
        ON system_faults (status, last_seen_at DESC)
    """)
    # Flap detection counts AUTO_HEALED rows for a key inside a time window.
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_system_faults_key_resolved
        ON system_faults (fault_key, resolved_at)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_system_faults_key_resolved")
    op.execute("DROP INDEX IF EXISTS ix_system_faults_status_seen")
    op.execute("DROP INDEX IF EXISTS ix_system_faults_open")
    op.execute("DROP TABLE IF EXISTS system_faults")
    op.execute("DROP TYPE IF EXISTS fault_status")
    op.execute("DROP TYPE IF EXISTS fault_severity")
