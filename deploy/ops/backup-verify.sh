#!/usr/bin/env bash
#
# Independently verify that last night's backup actually happened and is usable.
#
# WHY THIS IS SEPARATE FROM backup_ems.sh
# ---------------------------------------
# On 2026-07-18 and 2026-07-19 the nightly backup produced no file AND no error
# line — the log jumps straight from 07-17 to 07-20. Nobody noticed for 8 days.
# A script can report its own failure, but it cannot report never having run.
# So this check runs on its own schedule and asserts the OUTCOME on disk rather
# than trusting the producer.
#
# Checks: a dump exists, it is recent, it is not suspiciously small, and gzip
# can actually read it (a corrupt archive is worse than none, because it looks
# like a backup until the day you need it).
#
# Optional dead-man's-switch: set HEALTHCHECK_URL in /etc/default/ems-backup to
# a healthchecks.io (or similar) check URL. It is pinged on success and
# /fail on failure, so a MISSING ping — this host being down entirely — also
# raises the alarm. Without it the script still logs and exits non-zero.
set -uo pipefail

DB_DIR=/opt/backups/db
MAX_AGE_HOURS=26          # nightly at 02:00 + generous slack
MIN_BYTES=102400          # 100 KB — a real dump is ~2 MB; smaller means truncated

[ -f /etc/default/ems-backup ] && . /etc/default/ems-backup
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup-verify: $*"; }

fail() {
  log "FAIL: $*"
  if [ -n "$HEALTHCHECK_URL" ]; then
    curl -fsS -m 10 --retry 3 "${HEALTHCHECK_URL}/fail" -d "$*" >/dev/null 2>&1 || true
  fi
  exit 1
}

newest=$(ls -1t "$DB_DIR"/*.sql.gz 2>/dev/null | head -1)
[ -n "$newest" ] || fail "no database dump found in $DB_DIR at all"

age_s=$(( $(date +%s) - $(stat -c %Y "$newest") ))
age_h=$(( age_s / 3600 ))
[ "$age_h" -le "$MAX_AGE_HOURS" ] || \
  fail "newest dump is ${age_h}h old (limit ${MAX_AGE_HOURS}h) — last night's backup did not run: $(basename "$newest")"

size=$(stat -c %s "$newest")
[ "$size" -ge "$MIN_BYTES" ] || \
  fail "newest dump is only ${size} bytes (min ${MIN_BYTES}) — truncated: $(basename "$newest")"

gzip -t "$newest" 2>/dev/null || \
  fail "newest dump fails gzip integrity check — corrupt: $(basename "$newest")"

# Long-term retention: warn (do not fail) if this calendar month has no archive
# copy yet after the 2nd, since the 7-year POPIA copy is taken on the first run.
month=$(date +%Y%m)
if [ "$(date +%d)" -gt 02 ] && ! ls /opt/backups/monthly/*"${month}"*.sql.gz >/dev/null 2>&1; then
  log "WARNING: no monthly archive copy for ${month} yet (7-year retention)"
fi

log "OK: $(basename "$newest") ${age_h}h old, $(numfmt --to=iec "$size" 2>/dev/null || echo "${size}B"), gzip valid"
if [ -n "$HEALTHCHECK_URL" ]; then
  curl -fsS -m 10 --retry 3 "$HEALTHCHECK_URL" >/dev/null 2>&1 || true
fi
exit 0
