#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# EMS Claims Portal — UFW Firewall Setup
# Target: Hetzner Cloud Johannesburg servers
#
# Usage:
#   chmod +x ufw-setup.sh
#   sudo ./ufw-setup.sh
#
# ⚠️  Replace 10.0.0.0/8 with your actual Hetzner private network CIDR
#     before running.  You can find it under Hetzner Cloud → Networks.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────
# Internal/private network CIDR — Hetzner Cloud private networking
# Update this to your actual Hetzner private subnet (e.g. 10.0.1.0/24)
INTERNAL_NET="10.0.0.0/8"

echo "═══════════════════════════════════════════════════"
echo "  EMS Claims Portal — UFW Firewall Setup"
echo "  Internal network: ${INTERNAL_NET}"
echo "═══════════════════════════════════════════════════"

# ── Reset existing rules ─────────────────────────────────────────────────
echo ""
echo "→ Resetting UFW to defaults..."
ufw --force reset

# ── Default policies ─────────────────────────────────────────────────────
# Deny all incoming, allow all outgoing — whitelist model
echo "→ Setting default policies..."
ufw default deny incoming
ufw default allow outgoing

# ── SSH (port 22) ────────────────────────────────────────────────────────
# Allow from anywhere — we rely on fail2ban + key-only auth for protection.
# To further lock down, replace with: ufw allow from <your-office-IP> to any port 22
echo "→ Allowing SSH (22/tcp)..."
ufw allow 22/tcp comment "SSH"

# ── HTTP & HTTPS (ports 80, 443) ────────────────────────────────────────
# Public-facing — Nginx terminates TLS here
echo "→ Allowing HTTP (80/tcp) and HTTPS (443/tcp)..."
ufw allow 80/tcp comment "HTTP"
ufw allow 443/tcp comment "HTTPS"

# ── PostgreSQL (port 5432) — internal only ──────────────────────────────
# Only app servers and the standby DB should reach the primary database.
echo "→ Allowing PostgreSQL (5432/tcp) from internal network..."
ufw allow from ${INTERNAL_NET} to any port 5432 proto tcp comment "PostgreSQL - internal"

# ── PgBouncer (port 6432) — internal only ───────────────────────────────
# Connection pooler sits in front of PostgreSQL
echo "→ Allowing PgBouncer (6432/tcp) from internal network..."
ufw allow from ${INTERNAL_NET} to any port 6432 proto tcp comment "PgBouncer - internal"

# ── RabbitMQ (port 5672) — internal only ────────────────────────────────
# AMQP broker for Celery — only workers and app servers need access
echo "→ Allowing RabbitMQ (5672/tcp) from internal network..."
ufw allow from ${INTERNAL_NET} to any port 5672 proto tcp comment "RabbitMQ AMQP - internal"

# ── RabbitMQ Management UI (port 15672) — internal only ─────────────────
# Optional: management console for debugging
echo "→ Allowing RabbitMQ Management (15672/tcp) from internal network..."
ufw allow from ${INTERNAL_NET} to any port 15672 proto tcp comment "RabbitMQ Management - internal"

# ── Monitoring (ports 9090, 9100, 3000, 3100) — internal only ──────────
# Prometheus, node_exporter, Grafana, Loki
echo "→ Allowing monitoring ports from internal network..."
ufw allow from ${INTERNAL_NET} to any port 9090 proto tcp comment "Prometheus - internal"
ufw allow from ${INTERNAL_NET} to any port 9100 proto tcp comment "node_exporter - internal"
ufw allow from ${INTERNAL_NET} to any port 3000 proto tcp comment "Grafana - internal"
ufw allow from ${INTERNAL_NET} to any port 3100 proto tcp comment "Loki - internal"

# ── Enable UFW ───────────────────────────────────────────────────────────
echo ""
echo "→ Enabling UFW..."
ufw --force enable

# ── Show final status ────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo "  UFW Status"
echo "═══════════════════════════════════════════════════"
ufw status verbose

echo ""
echo "✅ Firewall configured successfully"
echo ""
echo "⚠️  IMPORTANT: Verify you can still SSH in from another terminal"
echo "   before closing this session!"
