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
| Encryption at rest | 🟡 | Azure-managed disk + database encryption (AES-256). **Patient ID numbers are NOT field-encrypted** — see below |
| Field-level encryption of patient IDs | ⬜ | **NOT IMPLEMENTED.** The column is `String(13)`, too small to hold a Fernet token, and there is no encrypt call on the write path. `ENCRYPTION_KEY`/Fernet currently protects provider SMTP app passwords only. Tracked as a post-pilot task — **do not claim this anywhere until it ships** |
| Encryption in transit | ✅ | Public HTTPS live since 2026-07-13 (Let's Encrypt, auto-renewing); App↔DB uses SSL (`PGSSLMODE=require`) |
| No hardcoded secrets | ✅ | As of 2026-07-28. Previously FALSE: `reset_password.py` carried a plaintext admin password and three scripts carried a live LlamaCloud API key, all tracked while the repo was public. Removed in 35f3d2c; **the exposed LlamaCloud key still needs revoking at the provider** |
| Automated backups | ✅ | `backup-ems.sh` nightly; 14-day daily + 7-year monthly retention; verified nightly by `backup-verify.sh` |
| Backup restore proven | ✅ | `restore-test.sh` weekly — restores the newest dump into an isolated `--network none` container, then compares (a) row counts across all 22 tables and (b) an md5 fingerprint over every **finalised** (non-draft) PRF's `prf_number + form_data + status + patient_signature + crew_signature`. Drafts are excluded by design: they legitimately change after the dump. First ever successful restore 2026-07-28; the fingerprint demonstrably catches a single altered character that row counts, gzip validity and a clean restore all miss. **Say it in those terms** — this is NOT a byte-for-byte comparison of the whole database, and describing it as one is the fastest way to lose credibility on our strongest control |
| Off-box backup copy | 🟡 | `backup-offsite.sh` written and fault-tested against a mock Blob endpoint, wired to cron at 02:30 — **dormant until `AZURE_SAS_URL` is set** in `/etc/default/ems-backup`. Until then every copy still lives only on this VM |

---

## Open items (priority order)

1. **Fix DNS `portal` A record** `127.209.218.22` → `172.209.218.22` (you have cPanel
   Zone Editor access) — unblocks HTTPS + cert.
2. **Issue TLS cert & enable HTTPS** — follow `../GO-LIVE-RUNBOOK.md` steps 1–2.
3. **Off-box backups** — replicate `/opt/backups` to Azure Blob Storage.
4. *(optional)* **WAF** — Cloudflare free tier once ready to move nameservers.

Re-audit any time with [`../scripts/verify-security.sh`](../scripts/verify-security.sh).
