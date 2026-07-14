# EMS Portal — Security Hardening Checklist

Status of the four-layer hardening (CIS Benchmark / NIST aligned) for
`portal.emsmca.co.za`. Last reviewed **2026-07-13**.

Legend: ✅ done & verified · 🟡 partial / needs attention · ⬜ not yet done

---

## 1. Network & Access Security

| Item | Status | Notes |
|---|---|---|
| Default-deny firewall (Azure NSG) | ✅ | NSG `ems-portal-vm-nsg`: only 22/80/443 allowed; `DenyAllInBound` default |
| Host firewall (ufw) | ✅ | `harden-vm.sh` — default-deny in, allow 22/80/443 |
| HTTPS only + HTTP→HTTPS redirect | 🟡 | nginx redirect configured; **blocked on DNS typo** (127→172) until fixed |
| Free TLS certificate | 🟡 | Let's Encrypt via `ems_certbot`; issue once DNS resolves |
| Port 22 restricted (not open to world) | ✅ | NSG rule 300 scoped to admin IP `/32` (dynamic IP — see runbook) |
| SSH password auth disabled (key-only) | ✅ | `passwordauthentication no`; keys are ED25519/RSA |
| SSH root login disabled | ✅ | `harden-vm.sh` → `PermitRootLogin no` |

## 2. Operating System & Server Hardening

| Item | Status | Notes |
|---|---|---|
| Least privilege (app not run as root) | ✅ | Containers run as non-root `ems` user (see backend Dockerfile) |
| Automated security patches | ✅ | `unattended-upgrades` active |
| Unused services disabled | ✅ | No FTP/Telnet/print/file-sharing; only 22/80/443 + localhost DB/broker |
| Brute-force protection | ✅ | `fail2ban` sshd jail (5 fails/10 min → 1h ban) |

## 3. Web Application & API Security

| Item | Status | Notes |
|---|---|---|
| HSTS | ✅ | `nginx/security-headers.conf` (max-age 1y, includeSubDomains) |
| X-Frame-Options / X-Content-Type-Options | ✅ | `SAMEORIGIN` / `nosniff` |
| Content-Security-Policy | ✅ | Scoped default-src 'self' + Google Maps allowances |
| Rate limiting (auth + API) | ✅ | nginx: 5 req/min on `/api/auth/login`, 10 req/s API; app middleware too |
| Web Application Firewall (WAF) | ⬜ | Not deployed — Cloudflare free tier deferred (needs registrar nameserver change) |
| Basic DDoS protection | ✅ | Azure platform L3/4 by default |

## 4. Data & Environment Protection

| Item | Status | Notes |
|---|---|---|
| Encryption at rest | ✅ | Azure-managed disk encryption (AES-256); POPIA field encryption for patient IDs |
| Encryption in transit | 🟡 | App↔DB uses SSL; public HTTPS pending the DNS/cert step above |
| No hardcoded secrets | ✅ | Secrets in `.env.prod` (git-ignored, chmod 600); not in code/repo |
| Automated backups | ✅ | `backup-ems.sh` nightly; 14-day daily + 7-year monthly retention |
| Off-box backup copy | ⬜ | Backups currently on-VM only — copy to Azure Blob for VM-loss protection |

---

## Open items (priority order)

1. **Fix DNS `portal` A record** `127.209.218.22` → `172.209.218.22` (you have cPanel
   Zone Editor access) — unblocks HTTPS + cert.
2. **Issue TLS cert & enable HTTPS** — follow `../GO-LIVE-RUNBOOK.md` steps 1–2.
3. **Off-box backups** — replicate `/opt/backups` to Azure Blob Storage.
4. *(optional)* **WAF** — Cloudflare free tier once ready to move nameservers.

Re-audit any time with [`../scripts/verify-security.sh`](../scripts/verify-security.sh).
