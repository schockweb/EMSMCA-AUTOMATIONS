"""Account-lockout columns for provider portal + crew logins.

Adds failed_login_attempts / locked_until to service_providers and
crew_members, mirroring the existing columns on users. Uses idempotent
raw DDL (ADD COLUMN IF NOT EXISTS) because the dev DB is create_all-managed
and prod applies these by hand-running migrate_security.py.

Revision ID: c7d9e1f3a5b8
Revises: b3e5d7f9a1c4
Create Date: 2026-07-23
"""
from typing import Sequence, Union

from alembic import op

revision: str = 'c7d9e1f3a5b8'
down_revision: Union[str, Sequence[str], None] = 'b3e5d7f9a1c4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE service_providers "
        "ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER DEFAULT 0"
    )
    op.execute(
        "ALTER TABLE service_providers "
        "ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP WITH TIME ZONE"
    )
    op.execute(
        "ALTER TABLE crew_members "
        "ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER DEFAULT 0"
    )
    op.execute(
        "ALTER TABLE crew_members "
        "ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP WITH TIME ZONE"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE service_providers DROP COLUMN IF EXISTS failed_login_attempts")
    op.execute("ALTER TABLE service_providers DROP COLUMN IF EXISTS locked_until")
    op.execute("ALTER TABLE crew_members DROP COLUMN IF EXISTS failed_login_attempts")
    op.execute("ALTER TABLE crew_members DROP COLUMN IF EXISTS locked_until")
