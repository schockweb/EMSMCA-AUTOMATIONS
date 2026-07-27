#!/usr/bin/env bash
#
# Install the unattended-operation safety net on the production VM.
# Idempotent — safe to re-run after every deploy.
#
#   sudo bash /opt/ems/deploy/ops/install-ops-crons.sh
#
# What it installs and why each one exists:
#   1. nginx cert reload   — certbot renews but nothing reloads nginx, so the
#                            renewed cert was never served (site would hard-fail
#                            at expiry with no prior warning).
#   2. backup verification — a nightly backup silently failed to run on
#                            2026-07-18/19 and went unnoticed for 8 days.
#   3. docker prune        — build cache grows ~2 GB/week with nothing reclaiming
#                            it; a full root filesystem breaks everything at once.
#   4. logrotate           — /var/log/ems-*.log are the only record of backup and
#                            certificate health and nothing rotated them.
set -euo pipefail

OPS_DIR=/opt/ems/deploy/ops
[ -d "$OPS_DIR" ] || { echo "ERROR: $OPS_DIR not found — deploy the repo first"; exit 1; }

chmod +x "$OPS_DIR"/*.sh
echo "==> scripts made executable"

# ── 1. TLS: reload nginx when the certificate is renewed (04:17 daily) ──
cat > /etc/cron.d/ems-nginx-cert <<'EOF'
# Reload nginx if certbot has renewed the TLS certificate, and warn before expiry.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 4 * * * root /opt/ems/deploy/ops/nginx-cert-reload.sh >> /var/log/ems-nginx-cert.log 2>&1
EOF
chmod 644 /etc/cron.d/ems-nginx-cert
echo "==> installed /etc/cron.d/ems-nginx-cert (daily 04:17)"

# ── 2. Backups: verify last night's dump actually exists and is usable (07:30 daily) ──
cat > /etc/cron.d/ems-backup-verify <<'EOF'
# Independently assert that the nightly backup produced a fresh, valid dump.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 7 * * * root /opt/ems/deploy/ops/backup-verify.sh >> /var/log/ems-backup-verify.log 2>&1
EOF
chmod 644 /etc/cron.d/ems-backup-verify
echo "==> installed /etc/cron.d/ems-backup-verify (daily 07:30)"

# ── 3. Disk hygiene: reclaim docker build cache weekly (Sunday 03:40) ──
# Keeps images from the last 30 days so recent per-commit rollback tags survive.
cat > /etc/cron.d/ems-docker-prune <<'EOF'
# Reclaim docker build cache and stale images; a full root fs breaks everything.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
40 3 * * 0 root docker builder prune -af --filter until=168h >> /var/log/ems-prune.log 2>&1; docker image prune -af --filter until=720h >> /var/log/ems-prune.log 2>&1
EOF
chmod 644 /etc/cron.d/ems-docker-prune
echo "==> installed /etc/cron.d/ems-docker-prune (weekly, Sun 03:40)"

# ── 4. Rotate our own logs ──
cat > /etc/logrotate.d/ems <<'EOF'
/var/log/ems-backup.log /var/log/ems-backup-verify.log /var/log/ems-nginx-cert.log /var/log/ems-prune.log {
    monthly
    rotate 84
    compress
    delaycompress
    missingok
    notifempty
    create 0640 root adm
}
EOF
chmod 644 /etc/logrotate.d/ems
echo "==> installed /etc/logrotate.d/ems (monthly, 84 kept = 7 years)"

# ── Optional dead-man's-switch config stub ──
if [ ! -f /etc/default/ems-backup ]; then
  cat > /etc/default/ems-backup <<'EOF'
# Dead-man's-switch for the nightly backup.
# Create a free check at https://healthchecks.io, paste its ping URL here, and
# you will be alerted when the expected ping does NOT arrive — which is the only
# way to catch the backup never running (the 2026-07-18/19 failure mode).
# HEALTHCHECK_URL=https://hc-ping.com/your-uuid-here
EOF
  chmod 600 /etc/default/ems-backup
  echo "==> created /etc/default/ems-backup (add HEALTHCHECK_URL to enable alerting)"
fi

echo
echo "Installed cron jobs:"
ls -1 /etc/cron.d/ems-* 2>/dev/null | sed 's/^/  /'
echo
echo "Run the checks once now to confirm they work:"
echo "  sudo /opt/ems/deploy/ops/nginx-cert-reload.sh"
echo "  sudo /opt/ems/deploy/ops/backup-verify.sh"
