#!/usr/bin/env bash
#
# Arm the two things that are still dormant on this VM: off-site backups and
# alerting. Both are one value each, and both are useless if the value is wrong.
#
#   sudo bash /opt/ems/deploy/ops/arm-monitoring.sh \
#        --healthcheck 'https://hc-ping.com/<uuid>' \
#        --sas 'https://ACCOUNT.blob.core.windows.net/ems-backups?sv=...&sig=...'
#
#   sudo bash /opt/ems/deploy/ops/arm-monitoring.sh --verify-only
#
# WHY THIS EXISTS
# ---------------
# `backup-offsite.sh` and `backup-verify.sh` already read both values from
# /etc/default/ems-backup. What was missing is the part that PROVES they work.
# A backup credential that silently lacks permission, and an alerting URL that
# silently 404s, both fail exactly the same way as not being configured at all —
# except they look configured, which is worse. Everything here is verified
# against the real service, not merely written to a file.
#
# The SAS check includes a deliberate DELETE attempt that is EXPECTED TO FAIL.
# The container SAS is specified as Create + Write + List and NOT Delete, so
# that a compromised VM cannot erase the off-site copies using the credential
# stored on it. If the delete succeeds, that property is not in place and this
# script says so loudly — it is the one property that cannot be checked by
# reading the URL.
#
# Values are never echoed. Both are secrets: the SAS URL IS the credential.
set -uo pipefail

CONFIG=/etc/default/ems-backup
HEALTHCHECK_IN=""
SAS_IN=""
VERIFY_ONLY=0
rc=0

log()  { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) arm-monitoring: $*"; }
ok()   { log "  OK    $*"; }
bad()  { log "  FAIL  $*"; rc=1; }
warn() { log "  WARN  $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --healthcheck) HEALTHCHECK_IN="${2:-}"; shift 2 ;;
    --sas)         SAS_IN="${2:-}"; shift 2 ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    -h|--help)     sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "must run as root (it writes $CONFIG)" >&2; exit 2; }

# ── Write the values ────────────────────────────────────────────────────────
# Replace-or-append per key, so the comments install-ops-crons.sh wrote and any
# other key already in the file survive.
set_key() {
  local key="$1" val="$2"
  [ -f "$CONFIG" ] || { : > "$CONFIG"; chmod 600 "$CONFIG"; }
  cp -p "$CONFIG" "$CONFIG.bak-$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null
  grep -v "^[[:space:]]*${key}=" "$CONFIG" > "$CONFIG.tmp" 2>/dev/null || : > "$CONFIG.tmp"
  printf '%s="%s"\n' "$key" "$val" >> "$CONFIG.tmp"
  mv "$CONFIG.tmp" "$CONFIG"
  chmod 600 "$CONFIG"
  chown root:root "$CONFIG"
}

if [ "$VERIFY_ONLY" -eq 0 ]; then
  [ -n "$HEALTHCHECK_IN" ] && { set_key HEALTHCHECK_URL "$HEALTHCHECK_IN"; log "wrote HEALTHCHECK_URL to $CONFIG"; }
  [ -n "$SAS_IN" ]         && { set_key AZURE_SAS_URL   "$SAS_IN";         log "wrote AZURE_SAS_URL to $CONFIG"; }
  if [ -z "$HEALTHCHECK_IN" ] && [ -z "$SAS_IN" ]; then
    log "nothing passed — verifying what is already configured (same as --verify-only)"
  fi
fi

[ -f "$CONFIG" ] || { log "FAIL: $CONFIG does not exist. Run install-ops-crons.sh first."; exit 1; }
# shellcheck disable=SC1090
. "$CONFIG"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"
AZURE_SAS_URL="${AZURE_SAS_URL:-}"

perms=$(stat -c %a "$CONFIG")
[ "$perms" = "600" ] && ok "$CONFIG is mode 600" || bad "$CONFIG is mode $perms — it holds a credential, must be 600"

# ── Alerting ────────────────────────────────────────────────────────────────
log "checking alerting (HEALTHCHECK_URL)"
if [ -z "$HEALTHCHECK_URL" ]; then
  warn "HEALTHCHECK_URL is unset — a failed backup is SILENT. Nothing will tell you."
  rc=1
else
  code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$HEALTHCHECK_URL" 2>/dev/null)
  case "$code" in
    200) ok "ping accepted (HTTP 200) — this check is now live and expects a ping on schedule" ;;
    404) bad "HTTP 404 — the check does not exist at that URL. Alerting is NOT armed." ;;
    000) bad "no response — DNS, egress firewall, or a typo. Alerting is NOT armed." ;;
    *)   bad "HTTP $code — unexpected. Treat alerting as NOT armed until this is 200." ;;
  esac
  # The failure path is a different endpoint and is what actually pages you.
  fcode=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "${HEALTHCHECK_URL}/fail" -d "arm-monitoring test" 2>/dev/null)
  if [ "$fcode" = "200" ]; then
    ok "failure ping accepted — the check is now DOWN on purpose; the next real success clears it"
  else
    bad "failure ping returned HTTP $fcode — backup FAILURES would not alert even though successes register"
  fi
fi

# ── Off-site backups ────────────────────────────────────────────────────────
log "checking off-site backup credential (AZURE_SAS_URL)"
if [ -z "$AZURE_SAS_URL" ]; then
  warn "AZURE_SAS_URL is unset — every backup, and every PRF attachment, exists"
  warn "ONLY on this VM's disk. Losing the VM loses all of it, permanently."
  rc=1
else
  case "$AZURE_SAS_URL" in
    https://*.blob.core.windows.net/*\?*) ok "URL shape is a container SAS" ;;
    *) bad "not a container SAS URL (expected https://ACCOUNT.blob.core.windows.net/CONTAINER?sv=...)"; rc=1 ;;
  esac

  BASE="${AZURE_SAS_URL%%\?*}"; BASE="${BASE%/}"
  QUERY="${AZURE_SAS_URL#*\?}"
  probe="_armcheck/probe-$(date -u +%Y%m%dT%H%M%SZ).txt"
  body="arm-monitoring probe, safe to delete"
  url="$BASE/$probe?$QUERY"

  # 1. Write — the permission the nightly copy actually needs.
  code=$(curl -sS -m 60 -o /dev/null -w '%{http_code}' -X PUT \
         -H "x-ms-blob-type: BlockBlob" -H "Content-Type: text/plain" \
         --data-binary "$body" "$url" 2>/dev/null)
  case "$code" in
    201) ok "write accepted (201)" ;;
    403) bad "403 — SAS expired, lacks Create/Write, or the VM clock is skewed. Off-site backup would NOT run."; rc=1 ;;
    404) bad "404 — that container does not exist. Off-site backup would NOT run."; rc=1 ;;
    000) bad "no response — egress to Azure Blob is blocked from this VM."; rc=1 ;;
    *)   bad "unexpected HTTP $code on write."; rc=1 ;;
  esac

  if [ "$code" = "201" ]; then
    # 2. Read back — proves the blob is really there, not just accepted.
    len=$(curl -sS -m 30 -I "$url" 2>/dev/null | tr -d '\r' | awk -F': ' '/^[Cc]ontent-[Ll]ength/{print $2}')
    if [ "$len" = "${#body}" ]; then ok "read back and length matches ($len bytes)"
    else bad "read back as '$len' bytes, expected ${#body} — the copy is not trustworthy"; fi

    # 3. List — backup-verify.sh needs it to see what is off-site.
    lcode=$(curl -sS -m 30 -o /dev/null -w '%{http_code}' "$BASE?restype=container&comp=list&$QUERY" 2>/dev/null)
    [ "$lcode" = "200" ] && ok "list accepted (200)" || bad "list returned HTTP $lcode — backup-verify.sh cannot audit the off-site copies"

    # 4. Delete — MUST be refused. This is the property that makes the off-site
    #    copy survive a compromise of this VM.
    dcode=$(curl -sS -m 30 -o /dev/null -w '%{http_code}' -X DELETE "$url" 2>/dev/null)
    case "$dcode" in
      403) ok "delete correctly REFUSED (403) — a compromised VM cannot erase the off-site backups" ;;
      202|200)
        bad "delete SUCCEEDED (HTTP $dcode). The SAS grants Delete."
        bad "Anyone who gets this VM can erase every off-site backup with the credential on it."
        bad "Reissue the SAS with Create + Write + List ONLY, then re-run this script."
        ;;
      *) warn "delete returned HTTP $dcode — could not confirm delete is refused. Check the SAS permissions by hand." ;;
    esac
  fi
fi

# ── The crons that consume them ─────────────────────────────────────────────
log "checking the scheduled jobs that use these values"
for job in backup-offsite backup-verify; do
  if crontab -l 2>/dev/null | grep -q "$job" || grep -rqs "$job" /etc/cron.d/ 2>/dev/null; then
    ok "$job is scheduled"
  else
    bad "$job is NOT scheduled — run install-ops-crons.sh"
  fi
done

echo
if [ "$rc" -eq 0 ]; then
  log "ARMED. Off-site backup and alerting are configured AND verified against the real services."
  log "Next: run backup_ems.sh then backup-offsite.sh once, to put a real copy off the VM today."
else
  log "NOT fully armed — see the FAIL/WARN lines above. Nothing here is fixed by waiting."
fi
exit "$rc"
