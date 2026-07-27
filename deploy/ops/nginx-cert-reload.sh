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
# HOW IT DECIDES
# --------------
# It compares the certificate nginx is ACTUALLY SERVING (read off the TLS
# handshake on localhost:443) against the certificate ON DISK. That is a direct
# measurement of the failure mode rather than a proxy for it: if certbot has
# renewed and nginx has not picked it up, the two dates differ and we reload.
#
# Note both reads happen from the host or via ems_certbot — the nginx image
# has no openssl binary, which is what broke the first version of this check.
#
# `nginx -s reload` is graceful (existing connections drain on the old workers),
# so reloading is safe even if nothing changed.
#
# Installed by deploy/ops/install-ops-crons.sh as /etc/cron.d/ems-nginx-cert.
set -uo pipefail

CONTAINER="ems_nginx"
CERTBOT="ems_certbot"
DOMAIN="portal.emsmca.co.za"
CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
WARN_DAYS=14

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) cert-check: $*"; }

epoch_of() {  # "Oct 11 12:14:55 2026 GMT" -> epoch, or empty on failure
  local d; d=$(echo "$1" | tr -d '\r')
  [ -n "$d" ] && date -d "$d" +%s 2>/dev/null
}

docker inspect "$CONTAINER" >/dev/null 2>&1 || { log "ERROR: $CONTAINER not found"; exit 1; }

# ── What is nginx actually serving right now? ──
served_raw=$(echo | openssl s_client -servername "$DOMAIN" -connect 127.0.0.1:443 2>/dev/null \
             | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
served=$(epoch_of "$served_raw")
[ -n "$served" ] || { log "ERROR: could not read the served certificate on :443"; exit 1; }

# ── What is on disk? (certbot image has openssl; the nginx image does not) ──
disk_raw=$(docker exec "$CERTBOT" openssl x509 -enddate -noout -in "$CERT" 2>/dev/null | cut -d= -f2)
disk=$(epoch_of "$disk_raw")
[ -n "$disk" ] || { log "ERROR: could not read $CERT via $CERTBOT"; exit 1; }

days_left=$(( (disk - $(date +%s)) / 86400 ))

if [ "$disk" -gt "$served" ]; then
  log "certificate on disk is NEWER than the one being served (renewal not picked up) — reloading nginx"
  if docker exec "$CONTAINER" nginx -s reload 2>&1; then
    sleep 2
    now_raw=$(echo | openssl s_client -servername "$DOMAIN" -connect 127.0.0.1:443 2>/dev/null \
              | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    now_e=$(epoch_of "$now_raw")
    if [ -n "$now_e" ] && [ "$now_e" -ge "$disk" ]; then
      log "reload OK — now serving the renewed certificate, valid ${days_left} more days"
    else
      log "ERROR: reloaded but the served certificate did NOT change — investigate immediately"
      exit 1
    fi
  else
    log "ERROR: nginx reload FAILED — renewed certificate is NOT being served"
    exit 1
  fi
else
  log "served certificate is current; valid ${days_left} more days"
fi

# ── Expiry alarm: non-zero exit so cron failure surfaces it ──
if [ "$days_left" -lt "$WARN_DAYS" ]; then
  log "WARNING: certificate expires in ${days_left} days (threshold ${WARN_DAYS}) — renewal is NOT working"
  exit 2
fi

exit 0
