#!/usr/bin/env bash
#
# Rebuild the whole portal on a fresh VM, after the current one is gone.
#
#   bash rebuild-vm.sh --check     # what would block a rebuild right now
#   bash rebuild-vm.sh --run       # do it, stopping at anything it must not guess
#
# WHY THIS EXISTS
# ---------------
# The portal runs on one VM. That is a deliberate, reasonable choice for the
# current load — but it means the recovery time after losing that VM is however
# long it takes someone to remember all of this under pressure. Writing it down
# as a script is the cheapest possible improvement to that number: it turns "a
# few hours if the right person is awake" into something closer to forty
# minutes, and it can be rehearsed on a throwaway VM without touching anything.
#
# WHAT SURVIVES THE VM, AND WHAT DOES NOT
# ---------------------------------------
#   SURVIVES   the database. It is Azure Database for PostgreSQL, off this box,
#              with automated backups and point-in-time recovery. Losing the VM
#              does not lose a single PRF record.
#
#   DOES NOT   the uploads volume — PRF attachments, photos, provider logos.
#              These are a local Docker volume. backup-ems.sh archives them
#              nightly to /opt/backups, WHICH IS ON THE SAME VM. If the VM is
#              gone and AZURE_SAS_URL was never set, the attachments are gone
#              with it. Check that first; step 0 does.
#
#   DOES NOT   .env.prod. It is not in the repository, and ENCRYPTION_KEY cannot
#              be regenerated — without it every patient identifier in the
#              database is permanently unreadable. It must come from escrow.
#
# This script deliberately stops rather than guessing at anything irreversible.
set -uo pipefail

MODE="${1:---check}"
EMS_DIR="${EMS_DIR:-/opt/ems}"
REPO="${REPO:-git@github.com:emsmca/ems-portal.git}"
BRANCH="${BRANCH:-main}"

ok()   { echo "  [ ok ]  $*"; }
warn() { echo "  [warn]  $*"; WARNINGS=$((WARNINGS+1)); }
bad()  { echo "  [STOP]  $*"; BLOCKERS=$((BLOCKERS+1)); }
step() { echo; echo "── $* ──────────────────────────────────────────"; }

WARNINGS=0
BLOCKERS=0

# ═══════════════════════════════════════════════════════════════════════════
# 0. Can this even be done? Answer BEFORE the emergency, not during it.
# ═══════════════════════════════════════════════════════════════════════════
step "0. Recovery preconditions"

if [ -f "$EMS_DIR/.env.prod" ]; then
  ok ".env.prod present on this host"
  if grep -q "^ENCRYPTION_KEY=.\{20,\}" "$EMS_DIR/.env.prod" 2>/dev/null; then
    ok "ENCRYPTION_KEY is set"
  else
    bad "ENCRYPTION_KEY missing or too short — patient identifiers would be unreadable"
  fi
  if grep -q "^AZURE_SAS_URL=http" "$EMS_DIR/.env.prod" 2>/dev/null \
     || grep -q "^AZURE_SAS_URL=http" /etc/default/ems-backup 2>/dev/null; then
    ok "off-site backup copy is armed"
  else
    warn "AZURE_SAS_URL is NOT set — backups exist only on this VM."
    warn "  A VM loss therefore loses every PRF ATTACHMENT (the database itself"
    warn "  is off-box and safe). This is the single highest-value thing to fix"
    warn "  before relying on this script."
  fi
else
  warn "no .env.prod here — on a fresh VM this must be restored from escrow first"
fi

if [ -d /opt/backups/uploads ]; then
  n=$(ls -1 /opt/backups/uploads/*.tar.gz 2>/dev/null | wc -l)
  [ "$n" -gt 0 ] && ok "$n upload archives on disk (newest: $(ls -1t /opt/backups/uploads/*.tar.gz 2>/dev/null | head -1 | xargs -r basename))" \
                 || warn "no upload archives in /opt/backups/uploads"
fi

if [ "$MODE" = "--check" ]; then
  step "Rebuild readiness"
  echo "  blockers: $BLOCKERS   warnings: $WARNINGS"
  echo
  echo "  What a rebuild still needs a HUMAN for, and always will:"
  echo "    · a new VM, and the DNS A record repointed at its IP"
  echo "    · .env.prod from escrow (ENCRYPTION_KEY above all)"
  echo "    · a deploy key or token with read access to the repository"
  echo "    · the Azure database firewall opened to the new VM's IP"
  echo
  echo "  Run with --run on the NEW VM once those four are in hand."
  exit $([ "$BLOCKERS" -gt 0 ] && echo 1 || echo 0)
fi

[ "$MODE" = "--run" ] || { echo "usage: $0 [--check|--run]"; exit 2; }

# ═══════════════════════════════════════════════════════════════════════════
# 1. Host packages
# ═══════════════════════════════════════════════════════════════════════════
step "1. Docker"
if command -v docker >/dev/null 2>&1; then
  ok "docker already installed ($(docker --version))"
else
  echo "  installing docker..."
  curl -fsSL https://get.docker.com | sh || { bad "docker install failed"; exit 1; }
  systemctl enable --now docker
  ok "docker installed"
fi
docker compose version >/dev/null 2>&1 || { bad "docker compose plugin missing"; exit 1; }

# ═══════════════════════════════════════════════════════════════════════════
# 2. Source
# ═══════════════════════════════════════════════════════════════════════════
step "2. Source tree"
if [ -d "$EMS_DIR/.git" ]; then
  ok "$EMS_DIR already a checkout"
  git -C "$EMS_DIR" fetch origin "$BRANCH" && git -C "$EMS_DIR" reset --hard "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO" "$EMS_DIR" || {
    bad "clone failed — is the deploy key on this VM and registered on GitHub?"; exit 1; }
fi
ok "at $(git -C "$EMS_DIR" rev-parse --short HEAD)"

# ═══════════════════════════════════════════════════════════════════════════
# 3. Secrets — human, always
# ═══════════════════════════════════════════════════════════════════════════
step "3. Configuration"
if [ ! -f "$EMS_DIR/.env.prod" ]; then
  echo
  echo "  .env.prod is not here and CANNOT be generated."
  echo "  Copy it from escrow to $EMS_DIR/.env.prod and re-run."
  echo
  echo "  ENCRYPTION_KEY in particular must be the ORIGINAL value. A new key"
  echo "  does not fail loudly — it produces a working application in which"
  echo "  every patient identifier reads back empty."
  exit 1
fi
chmod 600 "$EMS_DIR/.env.prod"
ok ".env.prod present"

DBHOST=$(grep -oP "^DATABASE_URL=[^@]*@\K[^/:]+" "$EMS_DIR/.env.prod" 2>/dev/null)
if [ -n "${DBHOST:-}" ]; then
  if getent hosts "$DBHOST" >/dev/null 2>&1; then ok "database host $DBHOST resolves"
  else bad "database host $DBHOST does not resolve"; fi
  echo "  NOTE: the Azure PostgreSQL firewall must allow THIS VM's public IP."
  echo "        A new VM has a new IP. This is the most common rebuild failure."
fi

# ═══════════════════════════════════════════════════════════════════════════
# 4. nginx config for this domain
# ═══════════════════════════════════════════════════════════════════════════
step "4. nginx"
if [ -n "${PORTAL_DOMAIN:-}" ]; then
  PORTAL_HOST_IP="${PORTAL_HOST_IP:-$(curl -s -4 ifconfig.me 2>/dev/null)}" \
  PORTAL_ADMIN_EMAIL="${PORTAL_ADMIN_EMAIL:-admin@$PORTAL_DOMAIN}" \
    bash "$EMS_DIR/deploy/scripts/render-nginx.sh" && ok "nginx config rendered for $PORTAL_DOMAIN"
else
  warn "PORTAL_DOMAIN not set — skipping render-nginx.sh."
  warn "  nginx.conf hardcodes a domain in server_name AND both ssl_certificate"
  warn "  paths; on a VM without that certificate nginx exits at startup."
fi

# ═══════════════════════════════════════════════════════════════════════════
# 5. Certificate — nginx will not start without it
# ═══════════════════════════════════════════════════════════════════════════
step "5. TLS certificate"
if [ -n "${PORTAL_DOMAIN:-}" ] && [ ! -d "/var/lib/docker/volumes/ems_certbot_certs/_data/live/$PORTAL_DOMAIN" ]; then
  echo "  issuing for $PORTAL_DOMAIN (DNS must already point here)..."
  cd "$EMS_DIR" && docker compose -f docker-compose.prod.yml run --rm ems_certbot \
    certonly --webroot -w /var/www/certbot -d "$PORTAL_DOMAIN" \
    --agree-tos -m "${PORTAL_ADMIN_EMAIL:-admin@$PORTAL_DOMAIN}" --non-interactive \
    && ok "certificate issued" || warn "certbot failed — check DNS and port 80"
else
  ok "certificate present or domain not set"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 6. Uploads — the only application data that does NOT live off-box
# ═══════════════════════════════════════════════════════════════════════════
step "6. Uploads"
UP=$(ls -1t /opt/backups/uploads/*.tar.gz 2>/dev/null | head -1)
if [ -n "${UP:-}" ]; then
  docker volume create ems_upload_data >/dev/null
  docker run --rm -v ems_upload_data:/data -v "$(dirname "$UP")":/b alpine \
    tar xzf "/b/$(basename "$UP")" -C /data && ok "restored $(basename "$UP")"
  n=$(docker run --rm -v ems_upload_data:/data alpine sh -c 'find /data -type f | wc -l')
  ok "$n files in the uploads volume"
else
  warn "no upload archive found — attachments will be missing."
  warn "  PRF records themselves are in the database and unaffected."
fi

# ═══════════════════════════════════════════════════════════════════════════
# 7. Start
# ═══════════════════════════════════════════════════════════════════════════
step "7. Stack"
cd "$EMS_DIR" || exit 1
docker network create ems_db_net 2>/dev/null || true
docker compose -f docker-compose.prod.yml   up -d --build || { bad "app stack failed"; exit 1; }
docker compose -f docker-compose.worker.yml up -d --build || warn "worker stack failed"
docker restart ems_nginx >/dev/null 2>&1 || true

# The schema already exists (the database survived), so this is an upgrade, not
# a bootstrap. bootstrap_schema.py is for a brand-new database only — see
# deploy/CLIENT-VM-INSTALL.md step 2 for why `alembic upgrade head` cannot build
# the schema from nothing.
docker compose -f docker-compose.prod.yml exec -T ems_backend python -m alembic upgrade head \
  && ok "migrations at head" || warn "alembic upgrade failed — check the DB firewall"

# ═══════════════════════════════════════════════════════════════════════════
# 8. Ops cover, immediately — not "later"
# ═══════════════════════════════════════════════════════════════════════════
step "8. Backups and monitoring"
cp "$EMS_DIR/deploy/scripts/backup-ems.sh" /opt/ems/backup_ems.sh 2>/dev/null && chmod 700 /opt/ems/backup_ems.sh
bash "$EMS_DIR/deploy/ops/install-ops-crons.sh" >/dev/null 2>&1 \
  && ok "backup, verify, restore-test and prune crons installed" \
  || warn "cron install failed — a rebuilt VM with no backups is a second outage waiting"

# ═══════════════════════════════════════════════════════════════════════════
# 9. Prove it
# ═══════════════════════════════════════════════════════════════════════════
step "9. Verification"
for i in $(seq 1 60); do
  code=$(curl -sk -o /dev/null -w "%{http_code}" https://localhost/health 2>/dev/null || true)
  [ "$code" = "200" ] && { ok "health 200 after ${i}s"; break; }
  [ "$i" -eq 60 ] && bad "health check never passed"
  sleep 1
done

if [ -n "${PORTAL_DOMAIN:-}" ]; then
  for path in /api/mock-scheme/oauth/token /docs; do
    c=$(curl -s -o /dev/null -w '%{http_code}' "https://$PORTAL_DOMAIN$path" 2>/dev/null || true)
    case "$c" in
      403|404) ok "$path closed ($c)" ;;
      *)       bad "$path returned $c — expected 403/404" ;;
    esac
  done
fi

bash "$EMS_DIR/deploy/ops/tag-release.sh" >/dev/null 2>&1 \
  && ok "release tagged, so there is a rollback point from minute one"

step "Done"
echo "  blockers: $BLOCKERS   warnings: $WARNINGS"
echo
echo "  Still yours to do:"
echo "    · repoint DNS at this VM if you have not already"
echo "    · confirm the Azure database firewall allows this VM's IP"
echo "    · run deploy/ops/restore-test.sh once, to prove backups work HERE"
exit $([ "$BLOCKERS" -gt 0 ] && echo 1 || echo 0)
