#!/usr/bin/env bash
#
# Ship the nightly backup off the VM to Azure Blob Storage.
#
#   sudo bash /opt/ems/deploy/ops/backup-offsite.sh
#
# WHY THIS EXISTS
# ---------------
# Until this ran, every copy of the data — the nightly dumps, the 7-year POPIA
# archive and every PRF attachment — lived on one Azure VM's root disk. A disk
# loss, a bad `docker volume rm`, or ransomware would have destroyed all of it
# at once, permanently. Backups on the same machine as the thing they protect
# are not backups.
#
# SETUP (one-off)
# ---------------
# 1. Create a storage account and a PRIVATE container, e.g. "ems-backups".
# 2. Generate a container SAS with permissions:  Create + Write + List
#    ── deliberately WITHOUT Delete. ───────────────────────────────────────
#    This VM can add backups but cannot remove them. If the VM is ever
#    compromised, the attacker cannot erase the off-site copies with the
#    credential they find on it. That property is the entire point; do not
#    "simplify" the SAS by granting full access.
#    Set a long expiry (a SAS that quietly expires is a silent backup failure —
#    this script treats an auth error as a hard failure so it surfaces).
# 3. Put the URL in /etc/default/ems-backup (mode 600):
#      AZURE_SAS_URL="https://ACCOUNT.blob.core.windows.net/ems-backups?sv=...&sig=..."
# 4. Enable soft-delete + versioning on the container in the Azure portal, so an
#    overwrite is recoverable.
#
# Uses the Blob REST API through curl — no azcopy or az CLI to install or drift.
set -uo pipefail

BACKUP_ROOT=/opt/backups
CONFIG=/etc/default/ems-backup
MAX_SINGLE_PUT=$((256 * 1024 * 1024))   # Azure "Put Blob" ceiling for one request

log()  { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup-offsite: $*"; }
fail() {
  log "FAIL: $*"
  [ -n "${HEALTHCHECK_URL:-}" ] && curl -fsS -m 10 --retry 2 "${HEALTHCHECK_URL}/fail" -d "offsite: $*" >/dev/null 2>&1
  exit 1
}

[ -f "$CONFIG" ] && . "$CONFIG"
AZURE_SAS_URL="${AZURE_SAS_URL:-}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"

if [ -z "$AZURE_SAS_URL" ]; then
  log "AZURE_SAS_URL is not set in $CONFIG — off-site copy is NOT running."
  log "There is currently only ONE copy of the data, on this VM."
  exit 0   # not an error yet: dormant until armed
fi

case "$AZURE_SAS_URL" in
  https://*.blob.core.windows.net/*\?*) : ;;
  *) fail "AZURE_SAS_URL is not a container SAS URL (expected https://ACCOUNT.blob.core.windows.net/CONTAINER?sv=...)" ;;
esac

BASE="${AZURE_SAS_URL%%\?*}"     # https://acct.blob.core.windows.net/container
QUERY="${AZURE_SAS_URL#*\?}"     # sv=...&sig=...
BASE="${BASE%/}"

# Upload one file to <prefix>/<basename>, skipping it when an identically sized
# blob is already there. Returns 0 on success (or verified skip).
upload() {
  local src="$1" prefix="$2"
  local name size remote code remote_len
  name=$(basename "$src")
  size=$(stat -c %s "$src")
  remote="$BASE/$prefix/$name?$QUERY"

  if [ "$size" -gt "$MAX_SINGLE_PUT" ]; then
    fail "$name is $size bytes, above the $MAX_SINGLE_PUT single-request limit — needs block upload"
  fi

  # Already there with the same length? Don't re-send.
  remote_len=$(curl -sS -m 60 -I "$remote" 2>/dev/null | tr -d '\r' | awk -F': ' '/^[Cc]ontent-[Ll]ength/{print $2}')
  if [ -n "$remote_len" ] && [ "$remote_len" = "$size" ]; then
    log "  skip   $prefix/$name (already off-site, $size bytes)"
    return 0
  fi

  code=$(curl -sS -m 900 -o /dev/null -w '%{http_code}' \
        -X PUT -H "x-ms-blob-type: BlockBlob" \
        -H "Content-Type: application/octet-stream" \
        -H "Content-Length: $size" \
        --data-binary "@$src" "$remote" 2>/dev/null)

  case "$code" in
    201) ;;
    403) fail "403 from Azure for $name — SAS expired, lacks Create/Write, or the clock is skewed" ;;
    404) fail "404 from Azure for $name — the container in AZURE_SAS_URL does not exist" ;;
    *)   fail "unexpected HTTP $code uploading $name" ;;
  esac

  # Trust nothing: read the blob's length back and compare.
  remote_len=$(curl -sS -m 60 -I "$remote" 2>/dev/null | tr -d '\r' | awk -F': ' '/^[Cc]ontent-[Ll]ength/{print $2}')
  [ "$remote_len" = "$size" ] || fail "$name uploaded but verifies as '$remote_len' bytes, expected $size"

  log "  sent   $prefix/$name ($size bytes, verified)"
  return 0
}

sent=0
# Newest daily dump + uploads tarball, and the whole monthly archive (the 7-year
# POPIA copy is the one that must survive losing this machine).
newest_db=$(ls -1t "$BACKUP_ROOT"/db/*.sql.gz 2>/dev/null | head -1)
newest_up=$(ls -1t "$BACKUP_ROOT"/uploads/*.tar.gz 2>/dev/null | head -1)

[ -n "$newest_db" ] || fail "no database dump found in $BACKUP_ROOT/db"
upload "$newest_db" "db" && sent=$((sent+1))

if [ -n "$newest_up" ]; then
  upload "$newest_up" "uploads" && sent=$((sent+1))
else
  log "  WARN   no uploads tarball found — PRF attachments are NOT being copied off-site"
fi

for f in "$BACKUP_ROOT"/monthly/*; do
  [ -f "$f" ] || continue
  upload "$f" "monthly" && sent=$((sent+1))
done

log "OK: $sent file(s) verified off-site in Azure Blob"
[ -n "$HEALTHCHECK_URL" ] && curl -fsS -m 10 --retry 2 "$HEALTHCHECK_URL" >/dev/null 2>&1
exit 0
