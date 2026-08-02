"""Restore searching a PRF by patient ID, as an indexed lookup

Encrypting `form_data['patient_id_number']` broke the provider PRF search:
it runs `cast(form_data AS text) ILIKE :term`, which now sees ciphertext and
silently matches nothing. Silently, which is the worst part — an operator
typing an ID number gets an empty result and concludes the patient is not in
the system.

This adds the same keyed lookup hash the cases table already carries. It
restores the capability and is strictly faster than what it replaces: an
indexed equality check instead of detoasting and scanning every clinical blob
(each up to ~58KB, including base64 signatures) on every keystroke.

SCHEMA ONLY — `encrypt_patient_ids.py` populates it.

Revision ID: d1f7b93c6e40
Revises: c9e4a71f3b28
Create Date: 2026-08-02
"""
from alembic import op

revision = "d1f7b93c6e40"
down_revision = "c9e4a71f3b28"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE digital_prfs ADD COLUMN IF NOT EXISTS patient_id_hash VARCHAR(64)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_digital_prfs_patient_id_hash "
        "ON digital_prfs (patient_id_hash)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_digital_prfs_patient_id_hash")
    op.execute("ALTER TABLE digital_prfs DROP COLUMN IF EXISTS patient_id_hash")
