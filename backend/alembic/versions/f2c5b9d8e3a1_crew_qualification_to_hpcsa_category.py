"""crew_qualification_to_hpcsa_category

Backfills `crew_members.qualification` from the legacy SAPAESA tier codes
(BLS / ILS / ALS) onto HPCSA registration categories
(BAA / AEA / ECT / ECA / ANT / ECP).

Mapping decided 2026-05-16 with the product owner:
  BLS → BAA   (1:1 — BAA is the only BLS-tier HPCSA category)
  ILS → AEA   (1:1 — AEA is the only ILS-tier HPCSA category)
  ALS → ECP   (ambiguous — ALS tier covers both ANT and ECP. ECP picked
               because it has the broadest scope, so no crew will be
               wrongly blocked by scope-of-practice gating. Provider
               admins must re-pick `ANT` on any crew who is actually a
               Critical Care Assistant after this migration runs.)
  ICU → ECP   (legacy alias for the highest tier)

Anything that doesn't match one of the above is left alone — there should be
nothing in production matching this case, but if there is, an admin can fix
it via the provider dashboard rather than have this migration guess.

The migration also updates the column's default + comment to reflect the new
semantics. No type/length change is needed (still String(10), all category
codes are 3 chars).

Revision ID: f2c5b9d8e3a1
Revises: e8a3f1b2c4d5
Create Date: 2026-05-16
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'f2c5b9d8e3a1'
down_revision: Union[str, Sequence[str], None] = 'e8a3f1b2c4d5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Data backfill ─────────────────────────────────────────────────────────
    op.execute("""
        UPDATE crew_members SET qualification = 'BAA'
        WHERE UPPER(TRIM(qualification)) = 'BLS'
    """)
    op.execute("""
        UPDATE crew_members SET qualification = 'AEA'
        WHERE UPPER(TRIM(qualification)) = 'ILS'
    """)
    op.execute("""
        UPDATE crew_members SET qualification = 'ECP'
        WHERE UPPER(TRIM(qualification)) IN ('ALS', 'ICU')
    """)

    # ── Column metadata ──────────────────────────────────────────────────────
    op.execute("ALTER TABLE crew_members ALTER COLUMN qualification SET DEFAULT 'AEA'")
    op.execute(
        "COMMENT ON COLUMN crew_members.qualification IS "
        "'HPCSA registration category: BAA / AEA / ECT / ECA / ANT / ECP. "
        "Translated to billing tier via app.utils.hpcsa.to_tier when needed by rules/tariff.'"
    )


def downgrade() -> None:
    # Reverse the data backfill (best-effort — ECT, ECA, ANT all collapse to
    # ILS / ALS legacy tiers since the old taxonomy can't express them).
    op.execute("""
        UPDATE crew_members SET qualification = 'BLS'
        WHERE UPPER(TRIM(qualification)) = 'BAA'
    """)
    op.execute("""
        UPDATE crew_members SET qualification = 'ILS'
        WHERE UPPER(TRIM(qualification)) IN ('AEA', 'ECT', 'ECA')
    """)
    op.execute("""
        UPDATE crew_members SET qualification = 'ALS'
        WHERE UPPER(TRIM(qualification)) IN ('ANT', 'ECP')
    """)

    op.execute("ALTER TABLE crew_members ALTER COLUMN qualification SET DEFAULT 'ILS'")
    op.execute(
        "COMMENT ON COLUMN crew_members.qualification IS 'ILS / ALS / BLS'"
    )
