#!/usr/bin/env bash
#
# Prove that the newest database backup can actually be restored.
#
#   sudo bash /opt/ems/deploy/ops/restore-test.sh
#
# WHY THIS EXISTS
# ---------------
# Until 2026-07-28 no backup had ever been restored. A dump that exists, is
# recent, is the right size and passes `gzip -t` can still be useless — wrong
# schema, truncated COPY blocks, an unrestorable pg_dump version. The only
# evidence that a backup works is restoring it.
#
# WHAT IT DOES
# ------------
# Restores the newest dump into a throwaway PostgreSQL container started with
# `--network none`, so it is physically incapable of reaching the production
# database. It then compares the restored copy against live:
#   * row counts for every table that carries patient or billing data
#   * a content fingerprint over the PRF payloads themselves (form_data,
#     status and both signature blobs) — counts alone would not notice a
#     column of NULLs
# and prints a verdict. Live is only ever read with SELECT.
#
# Exit codes: 0 restore verified · 1 restore failed or mismatched · 2 setup error
set -uo pipefail

# Overridable so the check itself can be fault-tested against a deliberately
# corrupted dump — a verifier that has never failed is not a verified verifier.
DB_DIR="${DB_DIR:-/opt/backups/db}"
ENV_FILE="${ENV_FILE:-/opt/ems/.env.prod}"
SCRATCH=ems_restore_test
PGIMAGE=postgres:18-alpine
SCRATCH_PW=scratch_only_throwaway

log()  { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) restore-test: $*"; }
fail() { log "FAIL: $*"; cleanup; exit 1; }
setup_fail() { log "SETUP ERROR: $*"; cleanup; exit 2; }
cleanup() { docker rm -f "$SCRATCH" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

[ -f "$ENV_FILE" ] || setup_fail "$ENV_FILE not found"

DUMP=$(ls -1t "$DB_DIR"/*.sql.gz 2>/dev/null | head -1)
[ -n "$DUMP" ] || setup_fail "no dump found in $DB_DIR"
log "testing $(basename "$DUMP") ($(du -h "$DUMP" | cut -f1))"

PGUSER=$(grep -oP "^POSTGRES_USER=\K.*"     "$ENV_FILE")
PGPASSWORD=$(grep -oP "^POSTGRES_PASSWORD=\K.*" "$ENV_FILE")
PGDATABASE=$(grep -oP "^POSTGRES_DB=\K.*"   "$ENV_FILE")
PGHOST=$(grep -oP "^DATABASE_URL=[^@]*@\K[^/:]+" "$ENV_FILE")
[ -n "${PGHOST:-}" ] || setup_fail "could not parse DB host from $ENV_FILE"

# ── 1. Isolated scratch instance ────────────────────────────────────────────
cleanup
docker run -d --name "$SCRATCH" --network none \
  -e POSTGRES_PASSWORD="$SCRATCH_PW" -e POSTGRES_DB=restore_check \
  "$PGIMAGE" >/dev/null || setup_fail "could not start scratch container"

for i in $(seq 1 60); do
  docker exec "$SCRATCH" pg_isready -U postgres -d restore_check >/dev/null 2>&1 && break
  [ "$i" -eq 60 ] && setup_fail "scratch instance never became ready"
  sleep 1
done
log "scratch instance ready (network: none)"

# ── 2. Restore ──────────────────────────────────────────────────────────────
errlog=$(mktemp)
zcat "$DUMP" | docker exec -i "$SCRATCH" \
  psql -U postgres -d restore_check -v ON_ERROR_STOP=0 >/dev/null 2>"$errlog"

# Azure Flexible Server dumps carry GRANTs for roles that exist only on Azure
# (azure_pg_admin, azuresu). Those failing is expected and harmless — no data
# is involved. Anything else is a real restore error.
real_errors=$(grep '^ERROR' "$errlog" 2>/dev/null | grep -vcE 'role "(azure_pg_admin|azuresu|azure_superuser)" does not exist')
azure_errors=$(grep -c '^ERROR.*azure' "$errlog" 2>/dev/null || echo 0)
log "restore completed (${azure_errors} ignorable Azure GRANT errors, ${real_errors} real errors)"
if [ "${real_errors:-0}" -gt 0 ]; then
  log "first real errors:"; grep '^ERROR' "$errlog" | grep -vE 'role "(azure_pg_admin|azuresu|azure_superuser)"' | head -5 | sed 's/^/    /'
  rm -f "$errlog"; fail "restore produced $real_errors real errors"
fi
rm -f "$errlog"

q_scratch() { docker exec "$SCRATCH" psql -U postgres -d restore_check -tAc "$1" 2>/dev/null; }
q_live() {
  docker run --rm -e PGPASSWORD="$PGPASSWORD" -e PGSSLMODE=require "$PGIMAGE" \
    psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -tAc "$1" 2>/dev/null
}

tables=$(q_scratch "select count(*) from information_schema.tables where table_schema='public'")
[ "${tables:-0}" -ge 15 ] || fail "only ${tables:-0} tables restored — expected the full schema"
log "schema restored: $tables tables"

# ── 3. Row counts ───────────────────────────────────────────────────────────
# A dump is a photograph of the past, so `restored == live` is the WRONG
# assertion — crews add PRFs between 02:00 and this check every single day, and
# a test that cries wolf daily gets ignored, which is how the 2026-07-18 backup
# failure went unnoticed for 8 days. The assertions that actually mean something:
#
#   restored >  live   HARD FAIL. Rows present in the backup are missing from
#                      production. Either production lost data, or this dump is
#                      not from this database. Both are emergencies.
#   restored == 0      HARD FAIL when live has rows — the dump is empty.
#   restored <  live   normal drift; reported, not failed.
problems=0
for t in digital_prfs claims cases documents crew_members vehicles service_providers users; do
  r=$(q_scratch "select count(*) from $t"); l=$(q_live "select count(*) from $t")
  if [ -z "$r" ] || [ -z "$l" ]; then
    printf '  WARN  %-20s could not compare (table missing on one side)\n' "$t"; continue
  fi
  if   [ "$r" -gt "$l" ]; then
    printf '  LOST  %-20s backup=%s live=%s  <-- production is MISSING rows\n' "$t" "$r" "$l"
    problems=$((problems+1))
  elif [ "$r" -eq 0 ] && [ "$l" -gt 0 ]; then
    printf '  EMPTY %-20s backup=0 live=%s  <-- dump has no rows for this table\n' "$t" "$l"
    problems=$((problems+1))
  elif [ "$r" -eq "$l" ]; then printf '  OK    %-20s %s\n' "$t" "$r"
  else printf '  drift %-20s backup=%s live=%s (+%s since dump)\n' "$t" "$r" "$l" "$((l-r))"
  fi
done

# ── 4. Content fingerprint over IMMUTABLE records ───────────────────────────
# Counts cannot detect a column restored as NULLs, so fingerprint the payloads.
# Restricted to PRFs that were already finalised at dump time (status <> DRAFT):
# the backend rejects edits to those with 423, so their content must be
# byte-identical in the backup and in live forever. Draft PRFs are excluded
# precisely because they are expected to change. This gives a strong integrity
# check with no day-to-day noise.
FP="select coalesce(md5(string_agg(
      prf_number||coalesce(form_data::text,'')||status::text||
      coalesce(patient_signature,'')||coalesce(crew_signature,''), '|' order by id::text)),'none')
    from digital_prfs where status::text <> 'DRAFT'"
fp_r=$(q_scratch "$FP")
n_immutable=$(q_scratch "select count(*) from digital_prfs where status::text <> 'DRAFT'")

if [ "${n_immutable:-0}" -eq 0 ]; then
  log "no finalised PRFs in this dump — skipping content fingerprint"
else
  # Compare against exactly the same id set on the live side.
  ids=$(q_scratch "select string_agg(quote_literal(id::text),',') from digital_prfs where status::text <> 'DRAFT'")
  fp_l=$(q_live "select coalesce(md5(string_agg(
          prf_number||coalesce(form_data::text,'')||status::text||
          coalesce(patient_signature,'')||coalesce(crew_signature,''), '|' order by id::text)),'none')
         from digital_prfs where id::text in ($ids)")
  if [ "$fp_r" = "$fp_l" ]; then
    log "content fingerprint MATCHES live across $n_immutable finalised PRFs (${fp_r:0:16}...)"
  else
    log "content fingerprint MISMATCH on finalised PRFs: backup=${fp_r:0:16}... live=${fp_l:0:16}..."
    log "  These records are immutable, so they must never differ. Either the dump is"
    log "  corrupt or finalised patient records were altered in production."
    problems=$((problems+1))
  fi
fi

[ "$problems" -eq 0 ] || fail "$problems integrity problem(s) — this backup is NOT trustworthy"
log "OK: $(basename "$DUMP") restores cleanly and its records match production"
exit 0
