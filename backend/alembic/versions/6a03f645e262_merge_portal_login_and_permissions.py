"""merge_portal_login_and_permissions

Revision ID: 6a03f645e262
Revises: d7e8f9a0b1c2, f2a3b4c5d6e7
Create Date: 2026-06-21 12:15:36.910090

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6a03f645e262'
down_revision: Union[str, Sequence[str], None] = ('d7e8f9a0b1c2', 'f2a3b4c5d6e7')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
