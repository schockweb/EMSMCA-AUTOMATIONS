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

# Overridable so the checks can be fault-tested against deliberately broken
# backup trees. A verifier nobody has ever seen fail is not a verifier.
BACKUP_ROOT="${BACKUP_ROOT:-/opt/backups}"
DB_DIR=$BACKUP_ROOT/db
UP_DIR=$BACKUP_ROOT/uploads
MONTHLY_DIR=$BACKUP_ROOT/monthly
MAX_AGE_HOURS=26          # nightly at 02:00 + generous slack
MIN_BYTES=102400          # 100 KB — a real dump is ~2 MB; smaller means truncated

# The monthly archive is the 7-year POPIA copy. It must be within this fraction
# of the current daily dump; anything smaller is not a real archive.
# WHY: the only monthly copy that existed was taken on install day, when the
# database was empty — 18 KB against a 10 MB daily dump. It satisfied every
# check below (it existed, for the right month) so the legal retention archive
# read as healthy while containing ZERO patient records. Size alone is the
# difference between an archive and a headstone.
MONTHLY_MIN_RATIO_PCT=50

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

# ── Uploads tarball — the PRF attachments ──────────────────────────────────
# Previously unchecked entirely: the database half of the backup was verified
# while the attachments could have been silently failing for months.
newest_up=$(ls -1t "$UP_DIR"/*.tar.gz 2>/dev/null | head -1)
if [ -z "$newest_up" ]; then
  fail "no uploads tarball in $UP_DIR — PRF attachments are not being backed up"
fi
up_age_h=$(( ( $(date +%s) - $(stat -c %Y "$newest_up") ) / 3600 ))
[ "$up_age_h" -le "$MAX_AGE_HOURS" ] || \
  fail "newest uploads tarball is ${up_age_h}h old — attachment backup did not run: $(basename "$newest_up")"
gzip -t "$newest_up" 2>/dev/null || \
  fail "uploads tarball fails gzip integrity check — corrupt: $(basename "$newest_up")"

# An empty tar.gz is 85 bytes, valid gzip, and completely useless. That is the
# exact artefact produced if the uploads volume goes missing, because docker
# silently creates an empty volume rather than failing. Count the members.
up_files=$(tar tzf "$newest_up" 2>/dev/null | grep -vc '/$')
[ "${up_files:-0}" -gt 0 ] || \
  fail "uploads tarball contains ZERO files — attachments are not being backed up: $(basename "$newest_up")"

# ── 7-year retention archive ───────────────────────────────────────────────
# Checked for presence AND for actually containing data (see MONTHLY_MIN_RATIO_PCT).
month=$(date +%Y%m)
newest_monthly=$(ls -1t "$MONTHLY_DIR"/ems_*"${month}"*.sql.gz 2>/dev/null | head -1)
if [ -z "$newest_monthly" ]; then
  if [ "$(date +%d)" -gt 02 ]; then
    log "WARNING: no monthly archive copy for ${month} yet (7-year retention)"
  fi
else
  m_size=$(stat -c %s "$newest_monthly")
  min_expected=$(( size * MONTHLY_MIN_RATIO_PCT / 100 ))
  if [ "$m_size" -lt "$min_expected" ]; then
    fail "7-year archive $(basename "$newest_monthly") is only ${m_size} bytes against a ${size}-byte daily dump — it is a stub, not an archive"
  fi
  gzip -t "$newest_monthly" 2>/dev/null || \
    fail "7-year archive fails gzip integrity check — corrupt: $(basename "$newest_monthly")"
  log "archive OK: $(basename "$newest_monthly") $(numfmt --to=iec "$m_size" 2>/dev/null || echo "${m_size}B")"
fi

# ── Off-site copy ──────────────────────────────────────────────────────────
# Backups that live only on this VM die with this VM. Report loudly when the
# off-site copy is not configured; it is a go-live blocker, not a nicety.
if [ -z "${AZURE_SAS_URL:-}" ]; then
  log "WARNING: no off-site copy configured (AZURE_SAS_URL unset) — every backup exists ONLY on this VM"
fi

log "OK: $(basename "$newest") ${age_h}h old, $(numfmt --to=iec "$size" 2>/dev/null || echo "${size}B"), gzip valid; uploads ${up_age_h}h old, gzip valid"
if [ -n "$HEALTHCHECK_URL" ]; then
  curl -fsS -m 10 --retry 3 "$HEALTHCHECK_URL" >/dev/null 2>&1 || true
fi
exit 0
