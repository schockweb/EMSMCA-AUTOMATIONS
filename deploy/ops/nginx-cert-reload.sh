#!/usr/bin/env bash
#
# Reload nginx when the TLS certificate has been renewed, and warn before expiry.
#
# WHY THIS EXISTS
# ---------------
# ems_certbot renews the certificate on a 12-hour loop, but nothing ever told
# nginx about it. nginx reads certificates once at worker start and holds them
# in memory, so a renewed certificate on disk is simply ignored: the old one
# keeps being served until it expires, and then every browser hard-fails with a
# security warning. The renewal succeeds silently ~30 days before that, so the
# failure arrives a month after the event that caused it, with no signal in
# between. This script closes that gap.
#
# It is deliberately conservative: `nginx -s reload` is a graceful reload —
# existing connections are served to completion by the old workers — so running
# it is safe even when nothing changed.
#
# Installed by deploy/ops/install-ops-crons.sh as /etc/cron.d/ems-nginx-cert.
set -uo pipefail

CONTAINER="ems_nginx"
DOMAIN="portal.emsmca.co.za"
CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
WARN_DAYS=14

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  log "ERROR: container $CONTAINER not found — cannot check or reload"
  exit 1
fi

# ── How long is the certificate nginx currently HAS on disk valid for? ──
not_after=$(docker exec "$CONTAINER" openssl x509 -enddate -noout -in "$CERT" 2>/dev/null | cut -d= -f2)
if [ -z "$not_after" ]; then
  log "ERROR: could not read $CERT inside $CONTAINER"
  exit 1
fi
exp_epoch=$(date -d "$not_after" +%s 2>/dev/null) || exp_epoch=0
now_epoch=$(date +%s)
days_left=$(( (exp_epoch - now_epoch) / 86400 ))

# ── Has the cert file been rewritten since nginx started? ──
# StartedAt is when the container (and therefore the nginx master) came up.
started_at=$(docker inspect "$CONTAINER" --format '{{.State.StartedAt}}')
started_epoch=$(date -d "$started_at" +%s 2>/dev/null) || started_epoch=0
# -L follows the live/ symlink through to the real archive/ file.
cert_mtime=$(docker exec "$CONTAINER" stat -L -c %Y "$CERT" 2>/dev/null || echo 0)

if [ "$cert_mtime" -gt "$started_epoch" ]; then
  log "certificate is NEWER than the running nginx (renewed) — reloading"
  if docker exec "$CONTAINER" nginx -s reload 2>&1; then
    log "nginx reloaded successfully; certificate valid for ${days_left} more days"
  else
    log "ERROR: nginx reload FAILED — the renewed certificate is NOT being served"
    exit 1
  fi
else
  log "no renewal since nginx started; certificate valid for ${days_left} more days"
fi

# ── Expiry alarm ──
# Non-zero exit makes this visible to any monitor that watches cron failures.
if [ "$days_left" -lt "$WARN_DAYS" ]; then
  log "WARNING: certificate expires in ${days_left} days (threshold ${WARN_DAYS}) — renewal is not working"
  exit 2
fi

exit 0
