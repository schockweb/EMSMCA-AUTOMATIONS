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
SCRIPTS_DIR=/opt/ems/deploy/scripts
[ -d "$OPS_DIR" ] || { echo "ERROR: $OPS_DIR not found — deploy the repo first"; exit 1; }

chmod +x "$OPS_DIR"/*.sh
echo "==> scripts made executable"

# ── 0. Sync the nightly backup script from version control ──────────────────
# /opt/ems/backup_ems.sh was installed by hand once and then edited in place, so
# it drifted from deploy/scripts/backup-ems.sh in the repo. Two copies of the
# thing that protects the data, and no way to tell which one was running.
# Installing it here makes the repo the single source of truth.
if [ -f "$SCRIPTS_DIR/backup-ems.sh" ]; then
  install -m 700 -o root -g root "$SCRIPTS_DIR/backup-ems.sh" /opt/ems/backup_ems.sh
  echo "==> installed /opt/ems/backup_ems.sh from version control"
fi
# The cron entries below invoke these through `bash` explicitly. The exec bit
# alone is not enough: git tracked these as 100644, so every `git reset --hard`
# during a deploy stripped it and cron failed with "Permission denied" on every
# run — silently, for two days. The mode is now tracked as 100755 AND cron no
# longer depends on it.

# ── 1. TLS: reload nginx when the certificate is renewed (04:17 daily) ──
cat > /etc/cron.d/ems-nginx-cert <<'EOF'
# Reload nginx if certbot has renewed the TLS certificate, and warn before expiry.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 4 * * * root /bin/bash /opt/ems/deploy/ops/nginx-cert-reload.sh >> /var/log/ems-nginx-cert.log 2>&1
EOF
chmod 644 /etc/cron.d/ems-nginx-cert
echo "==> installed /etc/cron.d/ems-nginx-cert (daily 04:17)"

# ── 2. Backups: verify last night's dump actually exists and is usable (07:30 daily) ──
cat > /etc/cron.d/ems-backup-verify <<'EOF'
# Independently assert that the nightly backup produced a fresh, valid dump.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 7 * * * root /bin/bash /opt/ems/deploy/ops/backup-verify.sh >> /var/log/ems-backup-verify.log 2>&1
EOF
chmod 644 /etc/cron.d/ems-backup-verify
echo "==> installed /etc/cron.d/ems-backup-verify (daily 07:30)"

# ── 2b. Off-site copy to Azure Blob (02:30 daily, after the 02:00 backup) ──
# Dormant until AZURE_SAS_URL is set in /etc/default/ems-backup; until then it
# logs that only one copy of the data exists and exits 0.
cat > /etc/cron.d/ems-backup-offsite <<'EOF'
# Ship the nightly backup off this VM. Backups on the same disk as the data are
# not backups: one disk loss, one bad volume rm, or ransomware takes both.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 2 * * * root /bin/bash /opt/ems/deploy/ops/backup-offsite.sh >> /var/log/ems-backup-offsite.log 2>&1
EOF
chmod 644 /etc/cron.d/ems-backup-offsite
echo "==> installed /etc/cron.d/ems-backup-offsite (daily 02:30)"

# ── 2c. Restore rehearsal (Sunday 05:00 weekly) ────────────────────────────
# A backup is only real if it restores. This restores the newest dump into a
# throwaway `--network none` container and compares it against production;
# production is only ever read. Takes ~30s and touches nothing live.
cat > /etc/cron.d/ems-restore-test <<'EOF'
# Weekly proof that the newest backup actually restores and its finalised
# patient records are byte-identical to production.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 5 * * 0 root /bin/bash /opt/ems/deploy/ops/restore-test.sh >> /var/log/ems-restore-test.log 2>&1
EOF
chmod 644 /etc/cron.d/ems-restore-test
echo "==> installed /etc/cron.d/ems-restore-test (weekly, Sun 05:00)"

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
/var/log/ems-backup.log /var/log/ems-backup-verify.log /var/log/ems-nginx-cert.log /var/log/ems-prune.log /var/log/ems-backup-offsite.log /var/log/ems-restore-test.log {
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
# ── Backup configuration. Mode 600: this file holds a credential. ──────────

# 1. DEAD-MAN'S-SWITCH
# Create a free check at https://healthchecks.io, paste its ping URL here, and
# you will be alerted when the expected ping does NOT arrive — which is the only
# way to catch the backup never running (the 2026-07-18/19 failure mode, which
# went unnoticed for 8 days because a script that never starts cannot report
# its own failure).
# HEALTHCHECK_URL=https://hc-ping.com/your-uuid-here

# 2. OFF-SITE COPY (Azure Blob Storage)
# Without this, every backup — including the 7-year POPIA archive and all PRF
# attachments — exists only on this VM's disk.
# Create a PRIVATE container and a container SAS with Create+Write+List and
# deliberately WITHOUT Delete, so a compromised VM cannot erase the off-site
# copies using the credential stored on it. Use a long expiry: a SAS that
# quietly expires is a silent backup failure.
# AZURE_SAS_URL="https://ACCOUNT.blob.core.windows.net/ems-backups?sv=...&sig=..."
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
