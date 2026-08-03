"""Stop searching PRFs by scanning the whole clinical blob

Provider PRF search ran `cast(form_data AS text) ILIKE '%term%'`. That detoasts
and reads the ENTIRE clinical payload of every one of that provider's records —
production rows average 150,260 bytes and are mostly base64 (crew and patient
signatures, ID document captures, scene photos), none of which anyone searches.

Measured 2026-08-03 on a provider with 559 PRFs, fully warm, zero disk reads:

    with the form_data clause     146 ms
    without it                    2.5 ms      <- 59x

The UI fires this on a 400 ms debounce with NO minimum term length, so typing a
six-letter surname was up to four consecutive full scans. At 5,000 PRFs for one
provider — a year of ordinary operation — that is roughly 1.3 seconds per
keystroke, per user, for as long as they keep typing.

WHAT THIS ADDS
--------------
`search_text`: the searchable text of a PRF, maintained by a trigger.

WHY A TRIGGER RATHER THAN APPLICATION CODE
------------------------------------------
form_data is written from several places — create, autosave PATCH, correction,
the identifier-encryption backfill, and repair scripts run by hand. The recurring
defect in this project is a rule implemented correctly on one path and never
carried to the others (it is why portal-unlock sat outside the auth rate limits,
and why the first encryption pass named 4 of 10 identifier keys). A stale search
index fails SILENTLY: the record simply stops being findable, and nobody notices
until someone cannot find a patient. The database is the one place every writer
must pass through.

WHAT IS IN IT, AND WHAT IS DELIBERATELY NOT
-------------------------------------------
Every string and number leaf, at any depth, minus ciphertext and base64:

  IN   patient name and surname, scheme, member number, call type, chief
       complaint, incident location, receiving facility, the narrative — every
       field anyone has ever actually searched for.

  IN   leaf text at ANY depth. Checked against real production data before
       shipping: `medications`, `iv_therapy`, `airway_interventions`,
       `circulation_interventions` and `mechanism` are all nested arrays, and
       they hold drug names and clinical interventions. A top-level-only index
       would have dropped every one of them while the query got faster — a
       search that is quick and cannot find the drug you gave is worse than a
       slow one.

  OUT  anything beginning `gAAAAA`, which is the Fernet version prefix. Encrypted
       identifiers are ciphertext — matching them was already impossible, and
       this rule is self-maintaining: a field encrypted in future drops out of
       the index automatically, with no list to update. That matters, because a
       hardcoded key list here would be the eleventh copy of one that has already
       been wrong once.

  OUT  long unbroken strings (>300 chars, no whitespace) — the shape of a base64
       blob that is not at the top level of a known key.

Searching by SA ID number is unaffected: it goes through `patient_id_hash`, an
indexed equality lookup added when identifiers were encrypted.

The backfill assigns search_text directly rather than re-saving form_data to fire
the trigger. That distinction is not cosmetic — see the comment on the UPDATE.

Revision ID: d5b7e91a3c62
Revises: c2f9a48d61be
Create Date: 2026-08-03
"""
from alembic import op
import sqlalchemy as sa

revision = "d5b7e91a3c62"
down_revision = "c2f9a48d61be"
branch_labels = None
depends_on = None


# ONE definition of what "searchable text" means, used by both the trigger and
# the backfill. Two copies would drift, and the way that failure presents is a
# record that is findable today and quietly unfindable after its next edit.
BUILD_FN = """
CREATE OR REPLACE FUNCTION ems_prf_search_text(fd jsonb)
RETURNS text AS $$
    SELECT left(string_agg(DISTINCT v, ' '), 20000)
    FROM (
        -- '$.**' walks EVERY level, not just the top.
        --
        -- The first version used jsonb_each, which is top-level only. Checked
        -- against real production data before shipping: 611 array values and 72
        -- object values live under keys including `medications`, `iv_therapy`,
        -- `airway_interventions`, `circulation_interventions` and `mechanism`.
        -- Those are drug names and clinical interventions — exactly the kind of
        -- thing someone searches for ("which calls gave adrenaline?"). Top-level
        -- only would have silently dropped all of it while the query got faster,
        -- which is the worst possible trade.
        SELECT j #>> '{}' AS v
        FROM jsonb_path_query(fd, '$.**') AS j
        WHERE jsonb_typeof(j) IN ('string', 'number')
    ) s
    WHERE v IS NOT NULL
      AND v <> ''
      -- Fernet version prefix: an encrypted identifier is ciphertext and was
      -- never matchable. Self-maintaining, so a field encrypted later drops out
      -- with no list to keep in step.
      AND v NOT LIKE 'gAAAAA%'
      -- A long string with no whitespace is a base64 payload, not prose.
      AND NOT (length(v) > 300 AND v !~ '\\s');
$$ LANGUAGE sql IMMUTABLE;
"""

TRIGGER_FN = """
CREATE OR REPLACE FUNCTION ems_digital_prfs_search_text()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.form_data IS NULL THEN
        NEW.search_text := NULL;
    ELSE
        NEW.search_text := ems_prf_search_text(NEW.form_data::jsonb);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""


def upgrade() -> None:
    op.add_column("digital_prfs", sa.Column("search_text", sa.Text(), nullable=True))

    op.execute(BUILD_FN)
    op.execute(TRIGGER_FN)
    op.execute("DROP TRIGGER IF EXISTS trg_digital_prfs_search_text ON digital_prfs")
    op.execute("""
        CREATE TRIGGER trg_digital_prfs_search_text
        BEFORE INSERT OR UPDATE OF form_data ON digital_prfs
        FOR EACH ROW EXECUTE FUNCTION ems_digital_prfs_search_text();
    """)

    # Backfill by assigning search_text DIRECTLY — never by re-assigning
    # form_data to fire the trigger.
    #
    # The first version of this migration did `SET form_data = d.form_data`,
    # which looks elegant (one definition of the rule) and is a trap: writing a
    # TOASTed column detoasts and REWRITES every out-of-line value, so a 1 GB
    # table rewrites 1 GB. On the load-test database that saturated PostgreSQL
    # to the point where an unrelated `SELECT count(*)` would not return, and
    # the migration had to be killed. Assigning search_text leaves form_data
    # untouched, so the new row version reuses the existing TOAST pointers and
    # only the small column is written.
    #
    # It still reads (and so detoasts) each row once, which is unavoidable. On a
    # table of a few million PRFs, run this statement outside the migration in
    # batches rather than holding one transaction over all of it.
    op.execute("""
        UPDATE digital_prfs
           SET search_text = ems_prf_search_text(form_data::jsonb)
         WHERE form_data IS NOT NULL
    """)

    # Trigram index, so `ILIKE '%term%'` can use an index at all — a btree
    # cannot serve a leading wildcard. Best-effort: pg_trgm is available on this
    # Azure Flexible Server but must be allow-listed in `azure.extensions`, and
    # the column alone is the bulk of the win (it is ~1/60th the bytes). If the
    # extension cannot be created, the search is still correct and still fast;
    # it just scans a small column instead of using an index.
    try:
        op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        op.execute("""
            CREATE INDEX IF NOT EXISTS ix_digital_prfs_search_text_trgm
            ON digital_prfs USING gin (search_text gin_trgm_ops)
        """)
    except Exception as exc:  # noqa: BLE001
        print(f"pg_trgm unavailable ({exc}); search_text created without a trigram index")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_digital_prfs_search_text_trgm")
    op.execute("DROP TRIGGER IF EXISTS trg_digital_prfs_search_text ON digital_prfs")
    op.execute("DROP FUNCTION IF EXISTS ems_digital_prfs_search_text()")
    op.execute("DROP FUNCTION IF EXISTS ems_prf_search_text(jsonb)")
    op.drop_column("digital_prfs", "search_text")
