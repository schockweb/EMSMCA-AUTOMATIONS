"""add portal login columns

Revision ID: d7e8f9a0b1c2
Revises: b7c1c790abab
Create Date: 2026-06-21 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd7e8f9a0b1c2'
down_revision: Union[str, Sequence[str], None] = 'b7c1c790abab'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('service_providers', sa.Column('portal_login_email', sa.String(length=255), nullable=True))
    op.add_column('service_providers', sa.Column('portal_login_password_hash', sa.String(length=255), nullable=True))
    op.create_index(op.f('ix_service_providers_portal_login_email'), 'service_providers', ['portal_login_email'], unique=True)


def downgrade() -> None:
    op.drop_index(op.f('ix_service_providers_portal_login_email'), table_name='service_providers')
    op.drop_column('service_providers', 'portal_login_password_hash')
    op.drop_column('service_providers', 'portal_login_email')
