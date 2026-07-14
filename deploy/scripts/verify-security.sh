#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# verify-security.sh — READ-ONLY audit of the EMS portal VM's security posture.
# Makes no changes. Run on the VM:  bash deploy/scripts/verify-security.sh
# Use it after hardening, after a reboot, or any time to check for drift.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

line() { printf '\n== %s ==\n' "$1"; }

line "SSH config (want: passwordauthentication no, permitrootlogin no)"
sudo sshd -T 2>/dev/null | grep -Ei '^(permitrootlogin|passwordauthentication|pubkeyauthentication)' || true

line "ufw firewall (want: active, default deny in, allow 22/80/443)"
sudo ufw status verbose 2>/dev/null | head -12 || echo "ufw not installed"

line "fail2ban SSH jail (want: active, some bans over time)"
sudo fail2ban-client status sshd 2>/dev/null | head -8 || echo "fail2ban not active"

line "Listening sockets (want: only 22/80/443 on 0.0.0.0; rest on 127.0.0.1)"
sudo ss -tlnp 2>/dev/null | awk 'NR>1 {print $4}' | sort -u

line "Automatic security updates"
systemctl is-active unattended-upgrades 2>/dev/null || echo "inactive"

line "TLS certificate"
sudo ls /etc/letsencrypt/live/ 2>/dev/null || echo "no Let's Encrypt cert yet"

line "Latest backups (want: recent .sql.gz and .tar.gz)"
sudo ls -lh /opt/backups/db      2>/dev/null | tail -3 || echo "no DB backups yet"
sudo ls -lh /opt/backups/monthly 2>/dev/null | tail -3 || echo "no monthly backups yet"

line "Pending OS updates"
sudo apt-get -s upgrade 2>/dev/null | grep -E '^[0-9]+ upgraded' || echo "unknown"

printf '\nDone. Anything unexpected above is drift — re-run harden-vm.sh to fix.\n'
