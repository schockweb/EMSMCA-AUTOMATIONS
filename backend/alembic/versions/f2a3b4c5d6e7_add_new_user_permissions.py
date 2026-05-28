"""Update existing users to include new permission keys.

Revision ID: f2a3b4c5d6e7
Revises: e1f2a3b4c5d6
Create Date: 2026-05-27

Adds 'providers', 'employees', 'failed_forms', 'system_health', and
'tariff_billing' to any user whose permissions column is a JSON array
that is missing these keys.
"""

from alembic import op

revision = "f2a3b4c5d6e7"
down_revision = "e1f2a3b4c5d6"
branch_labels = None
depends_on = None

NEW_PERMS = ["providers", "employees", "failed_forms", "system_health", "tariff_billing"]


def upgrade() -> None:
    # For each new permission key, append it to users who don't already have it.
    # This uses PostgreSQL's jsonb array containment operator.
    for perm in NEW_PERMS:
        op.execute(f"""
            UPDATE users
            SET permissions = permissions::jsonb || '["{perm}"]'::jsonb
            WHERE permissions IS NOT NULL
              AND NOT (permissions::jsonb @> '["{perm}"]'::jsonb)
        """)


def downgrade() -> None:
    # Remove the new permissions from all users
    for perm in NEW_PERMS:
        op.execute(f"""
            UPDATE users
            SET permissions = (
                SELECT jsonb_agg(elem)
                FROM jsonb_array_elements(permissions::jsonb) AS elem
                WHERE elem::text != '"{perm}"'
            )
            WHERE permissions IS NOT NULL
              AND permissions::jsonb @> '["{perm}"]'::jsonb
        """)
