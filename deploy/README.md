# EMS Portal — Deployment & Operations

Central index for running, securing, and maintaining the EMS Claims Portal in
production (Azure VM `ems-portal-vm` → `portal.emsmca.co.za`).

Everything an operator needs is linked from here. Scripts live in
[`scripts/`](scripts/); reference docs live beside this file.

---

## 📁 Folder map

```
deploy/
├── README.md                 ← you are here (the hub)
├── GO-LIVE-RUNBOOK.md        ← step-by-step first-time go-live
├── security/
│   └── SECURITY-CHECKLIST.md ← 4-layer hardening status (CIS/NIST aligned)
└── scripts/
    ├── harden-vm.sh          ← one-shot OS/network hardening (idempotent)
    ├── backup-ems.sh         ← nightly DB + uploads backup (tiered retention)
    └── verify-security.sh    ← read-only audit of the VM's security posture
```

> All scripts are written for the **VM** (Ubuntu 24.04). Run them there over SSH,
> not on your laptop. They assume the deploy dir is `/opt/ems`.

---

## 🚀 Common tasks

| I want to… | Do this |
|---|---|
| **Go live the first time** | Follow [GO-LIVE-RUNBOOK.md](GO-LIVE-RUNBOOK.md) top to bottom |
| **Harden a fresh/rebuilt VM** | `sudo bash deploy/scripts/harden-vm.sh` |
| **Check the VM is still locked down** | `bash deploy/scripts/verify-security.sh` |
| **Understand what's secured (and what isn't)** | [security/SECURITY-CHECKLIST.md](security/SECURITY-CHECKLIST.md) |
| **Set up / re-run backups** | Install `deploy/scripts/backup-ems.sh` on the VM (see its header) |
| **Deploy new code** | "Manual deploy procedure" section of [GO-LIVE-RUNBOOK.md](GO-LIVE-RUNBOOK.md) |

---

## 🔧 Scripts

### [`scripts/harden-vm.sh`](scripts/harden-vm.sh)
One-shot, **idempotent** OS + network hardening: disables SSH root login,
installs `fail2ban`, enables the `ufw` host firewall (default-deny, allow
22/80/443), and locks down secret-file permissions. Safe to re-run after a
rebuild. Pairs with the Azure NSG, which restricts port 22 to the admin IP.

### [`scripts/backup-ems.sh`](scripts/backup-ems.sh)
Nightly backup of the PostgreSQL database (via `pg_dump`) **and** the uploads
volume. Tiered retention: dailies kept 14 days, the first backup of each month
kept **7 years** for medical-record compliance. Installed on the VM via
`/etc/cron.d/ems-backup` at 02:00. This file is the version-controlled source
of truth — the VM copy should match it.

### [`scripts/verify-security.sh`](scripts/verify-security.sh)
**Read-only** audit — prints SSH config, firewall status, fail2ban jails, open
ports, auto-update status, TLS cert presence, and latest backups. Run it any
time to confirm nothing has drifted. Makes no changes.

---

## ⚠️ Operating notes

- **Backups currently live on the same VM** (`/opt/backups`). That covers app
  bugs and accidental deletion, but not total VM loss — copying them to Azure
  Blob Storage is the recommended next step for true off-box durability.
- **Port 22** is restricted to the admin's IP in the Azure NSG. That IP is
  dynamic, so SSH may drop when it changes — recover via Azure **Serial Console**
  or **Run Command** (neither needs port 22), then update the NSG rule.
- Do **not** rely on GitHub auto-deploy — see the warning in the runbook.
