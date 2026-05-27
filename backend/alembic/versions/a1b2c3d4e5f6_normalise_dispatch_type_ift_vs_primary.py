"""normalise_dispatch_type_ift_vs_primary

Revision ID: a1b2c3d4e5f6
Revises: 9f16b31598f3
Create Date: 2026-04-16 10:00:00.000000

Normalises the `cases.dispatch_type` column so that every row uses one of
exactly two canonical values: "Primary" or "IFT".

Legacy values that exist in production data:
  "IHT"                        → "IFT"   (old Inter-Hospital Transfer abbreviation)
  "Inter-Facility Transfer"    → "IFT"   (long-form string)
  "Inter-Hospital Transfer"    → "IFT"
  "inter-facility transfer"    → "IFT"   (lower-case variants from OCR)
  "ift"                        → "IFT"
  "iht"                        → "IFT"
  "primary"                    → "Primary"
  "PRIMARY"                    → "Primary"
  "primary response"           → "Primary"
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = '9f16b31598f3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Normalise all IFT variants → 'IFT' ──
    op.execute("""
        UPDATE cases
        SET dispatch_type = 'IFT'
        WHERE LOWER(TRIM(dispatch_type)) IN (
            'iht',
            'ift',
            'inter-facility transfer',
            'inter-hospital transfer',
            'interfacility transfer',
            'interhospital transfer',
            'inter-facility',
            'inter-hospital',
            'interfacility',
            'interhospital',
            'transfer'
        )
    """)

    # ── Normalise all Primary variants → 'Primary' ──
    op.execute("""
        UPDATE cases
        SET dispatch_type = 'Primary'
        WHERE LOWER(TRIM(dispatch_type)) IN (
            'primary',
            'primary response',
            'emergency',
            'scene',
            'scene response'
        )
    """)


def downgrade() -> None:
    # Downgrade is intentionally a no-op — we cannot reliably determine which
    # "IHT" rows were originally "IHT" vs "IFT", and the old format was buggy.
    # If a rollback is needed, restore from a database snapshot.
    pass
