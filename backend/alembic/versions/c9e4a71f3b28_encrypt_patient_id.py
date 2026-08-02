"""Encrypt the SA ID number at rest — widen the column, add the lookup hash

`cases.patient_id_number` was String(13): exactly the length of a South African
ID number, and far too small for a Fernet token (100 characters). There was
nowhere to put ciphertext even if the write path had encrypted it, which it did
not. This widens the column and adds the keyed lookup hash that keeps equality
searches and duplicate detection working once the value is unreadable.

SCHEMA ONLY. It does not touch a single existing value — the data itself is
converted by `backend/encrypt_patient_ids.py`, separately and reversibly, so
the schema change can go out, be verified, and be rolled back independently of
the far riskier data rewrite.

Widening a varchar to text is a metadata-only operation in PostgreSQL: no table
rewrite, no lock beyond a brief ACCESS EXCLUSIVE, no downtime at this size.

Revision ID: c9e4a71f3b28
Revises: b6d2f8a4c013
Create Date: 2026-08-02
"""
from alembic import op

revision = "c9e4a71f3b28"
down_revision = "b6d2f8a4c013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE cases ALTER COLUMN patient_id_number TYPE TEXT")
    op.execute("ALTER TABLE cases ADD COLUMN IF NOT EXISTS patient_id_hash VARCHAR(64)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_cases_patient_id_hash "
        "ON cases (patient_id_hash)"
    )


def downgrade() -> None:
    # Deliberately does NOT narrow the column back to String(13).
    #
    # Once any row holds a 100-character token, narrowing would raise
    # "value too long" and abort — or, with a USING clause, silently truncate
    # every encrypted patient identifier into garbage. A downgrade must not be
    # able to destroy data. Drop the hash and leave the column wide; a wide
    # column costs nothing.
    op.execute("DROP INDEX IF EXISTS ix_cases_patient_id_hash")
    op.execute("ALTER TABLE cases DROP COLUMN IF EXISTS patient_id_hash")
