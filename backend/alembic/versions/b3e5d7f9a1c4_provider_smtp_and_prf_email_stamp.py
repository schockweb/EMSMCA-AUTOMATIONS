"""Provider outbound SMTP account + PRF facility-email sent stamp

Revision ID: b3e5d7f9a1c4
Revises: a1c3e5f7b9d2
Create Date: 2026-07-22 00:00:00.000000

Each ServiceProvider gets its own outbound email account (Gmail / Outlook +
Fernet-encrypted app password) so submitted PRF PDFs are emailed to the
receiving facility FROM the provider's address. DigitalPRF gains an audit /
duplicate-send stamp recording where and when the PDF was emailed.
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'b3e5d7f9a1c4'
down_revision: Union[str, Sequence[str], None] = 'a1c3e5f7b9d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # IF NOT EXISTS keeps this safe on dev nodes where create_all (or a
    # hand-applied ALTER) already added the columns from the new models.
    op.execute(
        "ALTER TABLE service_providers "
        "ADD COLUMN IF NOT EXISTS smtp_service VARCHAR(20)"
    )
    op.execute(
        "ALTER TABLE service_providers "
        "ADD COLUMN IF NOT EXISTS smtp_email VARCHAR(255)"
    )
    op.execute(
        "ALTER TABLE service_providers "
        "ADD COLUMN IF NOT EXISTS smtp_password_encrypted TEXT"
    )
    op.execute(
        "ALTER TABLE digital_prfs "
        "ADD COLUMN IF NOT EXISTS facility_email_sent_to VARCHAR(255)"
    )
    op.execute(
        "ALTER TABLE digital_prfs "
        "ADD COLUMN IF NOT EXISTS facility_email_sent_at TIMESTAMPTZ"
    )
    op.execute(
        "ALTER TABLE digital_prfs "
        "ADD COLUMN IF NOT EXISTS facility_email_error VARCHAR(50)"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE digital_prfs DROP COLUMN IF EXISTS facility_email_error")
    op.execute("ALTER TABLE digital_prfs DROP COLUMN IF EXISTS facility_email_sent_at")
    op.execute("ALTER TABLE digital_prfs DROP COLUMN IF EXISTS facility_email_sent_to")
    op.execute("ALTER TABLE service_providers DROP COLUMN IF EXISTS smtp_password_encrypted")
    op.execute("ALTER TABLE service_providers DROP COLUMN IF EXISTS smtp_email")
    op.execute("ALTER TABLE service_providers DROP COLUMN IF EXISTS smtp_service")
