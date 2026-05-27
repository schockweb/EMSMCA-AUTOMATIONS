"""merge_heads

Revision ID: b7c1c790abab
Revises: a3b7c9d1e5f2, d6e7f8a9b0c1
Create Date: 2026-05-27 08:28:39.715539

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7c1c790abab'
down_revision: Union[str, Sequence[str], None] = ('a3b7c9d1e5f2', 'd6e7f8a9b0c1')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
