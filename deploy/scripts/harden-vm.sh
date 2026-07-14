#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# harden-vm.sh — one-shot OS + network hardening for the EMS portal VM.
# Target: Ubuntu 24.04 LTS on Azure (ems-portal-vm). Run on the VM as a
# sudo-capable user:  sudo bash deploy/scripts/harden-vm.sh
#
# Idempotent — safe to re-run (e.g. after a VM rebuild). Pairs with the Azure
# NSG, which restricts inbound port 22 to the admin IP (that part is done in
# the Azure portal / CLI, not here).
#
# First applied 2026-07-13. Verify afterwards with verify-security.sh.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

echo "== 1/4  SSH: disable root login (password auth is already off, key-only) =="
echo "PermitRootLogin no" | sudo tee /etc/ssh/sshd_config.d/99-ems-hardening.conf
sudo sshd -t && sudo systemctl reload ssh && echo "  sshd reloaded OK"

echo "== 2/4  fail2ban: ban SSH brute-force (5 fails / 10 min -> 1h ban) =="
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban >/dev/null
printf '[sshd]\nenabled = true\nbackend = systemd\nmaxretry = 5\nbantime = 1h\nfindtime = 10m\n' \
  | sudo tee /etc/fail2ban/jail.d/ems-sshd.local
sudo systemctl enable --now fail2ban

echo "== 3/4  ufw host firewall: default-deny inbound, allow only 22/80/443 =="
sudo ufw allow OpenSSH   >/dev/null
sudo ufw allow 80/tcp    >/dev/null
sudo ufw allow 443/tcp   >/dev/null
sudo ufw --force enable

echo "== 4/4  Lock down secret + DB-dump file permissions (0600) =="
sudo chmod 600 /opt/ems/.env.prod            2>/dev/null || true
sudo chmod 600 /opt/ems/.env.prod.bak-*      2>/dev/null || true
sudo chmod 600 /opt/ems/database_backup*.sql 2>/dev/null || true

echo
echo "✅ Hardening applied. Audit with: bash deploy/scripts/verify-security.sh"
