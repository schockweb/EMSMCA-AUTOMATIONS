"""users.permissions NOT NULL — remove the fail-open from the permission check

`has_permission` returned True for a NULL `permissions` column, on the reasoning
that NULL meant "not configured" while `[]` meant "deliberately stripped". That
was survivable while permissions were presentation-only. It stopped being
survivable once `require_permission` became the ONLY guard on several routers,
because any row with a NULL column — anything inserted by a script, a fixture or
a migration — silently held every permission regardless of role.

Making the column NOT NULL removes the third state. "Not configured" is no
longer representable, so the check has nothing to fail open ON.

Existing NULL rows are given the full permission set rather than an empty one:
they were BEHAVING as full-permission accounts under the old semantics, and a
migration that silently strips a working administrator's access at 02:00 is a
worse outcome than preserving what they effectively already had. Verified before
writing this: zero NULL rows in production and zero in the test database, so
this branch is a safety net rather than a data change.

The server default is '[]' — a NEW row that does not name its permissions gets
NONE. That is the opposite of the old model default and is deliberate: the
application always sets permissions explicitly (app/api/users.py), so the
default only fires for something that bypassed it, and the safe answer for an
account nobody configured is no access rather than all access.

Revision ID: a4d81c6b2f75
Revises: f7c1a9e35b84
Create Date: 2026-08-03
"""
from alembic import op

revision = "a4d81c6b2f75"
down_revision = "f7c1a9e35b84"
branch_labels = None
depends_on = None

# Kept as a literal rather than imported from app.models.user: a migration must
# describe the schema at THIS point in history, and importing a constant makes
# the migration's behaviour change whenever that list is edited later.
_ALL_PERMISSIONS_JSON = (
    '["dashboard","upload","admin_queue","document_review","adjudication",'
    '"edi_submit","era_tracking","analytics","payouts","ai_training","cases",'
    '"employee_management","settings","rule_builder","providers","employees",'
    '"failed_forms","system_health","tariff_billing"]'
)


def upgrade() -> None:
    op.execute(
        f"UPDATE users SET permissions = '{_ALL_PERMISSIONS_JSON}'::json "
        "WHERE permissions IS NULL"
    )
    op.execute("ALTER TABLE users ALTER COLUMN permissions SET DEFAULT '[]'::json")
    op.execute("ALTER TABLE users ALTER COLUMN permissions SET NOT NULL")


def downgrade() -> None:
    op.execute("ALTER TABLE users ALTER COLUMN permissions DROP NOT NULL")
    op.execute("ALTER TABLE users ALTER COLUMN permissions DROP DEFAULT")
