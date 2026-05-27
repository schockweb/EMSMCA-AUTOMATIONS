# EMS Digital PRF — Hetzner Production Deployment Guide

> **Target:** 5 servers in Hetzner Cloud Johannesburg (CPX region `fsn1` → `hil`)
> **Budget:** ~R1,420/month | **Stack:** Docker Compose per server role

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Server Provisioning](#2-server-provisioning)
3. [Base Setup (All Servers)](#3-base-setup-all-servers)
4. [Deploy DB Primary](#4-deploy-db-primary)
5. [Deploy DB Standby](#5-deploy-db-standby)
6. [Deploy Worker](#6-deploy-worker)
7. [Deploy App-1 & App-2](#7-deploy-app-1--app-2)
8. [Load Balancer](#8-load-balancer)
9. [SSL Certificates](#9-ssl-certificates)
10. [Run Migrations](#10-run-migrations)
11. [Deploy Monitoring](#11-deploy-monitoring)
12. [Verification](#12-verification)
13. [Maintenance Runbook](#13-maintenance-runbook)

---

## 1. Prerequisites

- [ ] Hetzner Cloud account ([cloud.hetzner.com](https://cloud.hetzner.com))
- [ ] `hcloud` CLI installed (`brew install hcloud` / `apt install hcloud-cli`)
- [ ] SSH key pair generated: `ssh-keygen -t ed25519 -f ~/.ssh/ems_hetzner`
- [ ] Domain name configured (e.g. `app.example.co.za`)
- [ ] DNS A records pointing to Hetzner Load Balancer IP
- [ ] GitHub repo with CI/CD secrets configured

```bash
# Authenticate hcloud CLI
hcloud context create ems-prod
# Enter your Hetzner API token when prompted
```

---

## 2. Server Provisioning

Upload your SSH key to Hetzner:
```bash
hcloud ssh-key create --name ems-deploy --public-key-from-file ~/.ssh/ems_hetzner.pub
```

Create all 5 servers:
```bash
# App-1 (CX32 — 4 vCPU, 8 GB)
hcloud server create --name ems-app-1 --type cx32 --image ubuntu-24.04 \
  --location hil --ssh-key ems-deploy

# App-2 (CX32 — 4 vCPU, 8 GB)
hcloud server create --name ems-app-2 --type cx32 --image ubuntu-24.04 \
  --location hil --ssh-key ems-deploy

# Worker (CX42 — 8 vCPU, 16 GB)
hcloud server create --name ems-worker --type cx42 --image ubuntu-24.04 \
  --location hil --ssh-key ems-deploy

# DB Primary (CX42 — 8 vCPU, 16 GB)
hcloud server create --name ems-db-primary --type cx42 --image ubuntu-24.04 \
  --location hil --ssh-key ems-deploy

# DB Standby (CX32 — 4 vCPU, 8 GB)
hcloud server create --name ems-db-standby --type cx32 --image ubuntu-24.04 \
  --location hil --ssh-key ems-deploy
```

Create the load balancer:
```bash
hcloud load-balancer create --name ems-lb --type lb11 --location hil

# Add targets
hcloud load-balancer add-target ems-lb --server ems-app-1
hcloud load-balancer add-target ems-lb --server ems-app-2

# Add HTTP service
hcloud load-balancer add-service ems-lb --protocol https --listen-port 443 \
  --destination-port 80 --http-redirect-http
```

Create a private network for inter-server communication:
```bash
hcloud network create --name ems-internal --ip-range 10.0.0.0/16
hcloud network add-subnet ems-internal --type server --network-zone eu-central --ip-range 10.0.1.0/24

# Attach all servers
for server in ems-app-1 ems-app-2 ems-worker ems-db-primary ems-db-standby; do
  hcloud server attach-to-network $server --network ems-internal
done
```

Note the private IPs:
```bash
hcloud server list -o columns=name,ipv4,private_net
```

---

## 3. Base Setup (All Servers)

SSH into each server and run:

```bash
# Update system
apt update && apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh
systemctl enable docker

# Install Docker Compose plugin
apt install -y docker-compose-plugin

# Create app user
useradd -m -s /bin/bash ems
usermod -aG docker ems

# Install Fail2ban
apt install -y fail2ban
cp /path/to/fail2ban-jail.local /etc/fail2ban/jail.local
systemctl enable fail2ban && systemctl start fail2ban

# Configure UFW firewall
bash /path/to/ufw-setup.sh
```

Clone the repo on each server:
```bash
su - ems
git clone https://github.com/YOUR_ORG/ems-automations.git ~/app
cd ~/app
```

Create the `.env.prod` file on each server (never committed to git):
```bash
cp backend/.env.example backend/.env.prod
nano backend/.env.prod
# Fill in real values: DATABASE_URL, SECRET_KEY, etc.
```

---

## 4. Deploy DB Primary

```bash
ssh ems@<DB_PRIMARY_IP>
cd ~/app

# Copy tuned PostgreSQL config
mkdir -p infra/postgres/data

# Create .env.prod with database credentials
cat > .env.prod << 'EOF'
POSTGRES_USER=ems_admin
POSTGRES_PASSWORD=<STRONG_PASSWORD_HERE>
POSTGRES_DB=ems_automations
EOF

# Start PostgreSQL + PgBouncer
docker compose -f docker-compose.db.yml up -d

# Verify
docker compose -f docker-compose.db.yml ps
docker exec ems_postgres pg_isready -U ems_admin
```

---

## 5. Deploy DB Standby

```bash
ssh ems@<DB_STANDBY_IP>
cd ~/app

# Create base backup from primary
docker run --rm -v ems_pg_data:/var/lib/postgresql/data postgres:16-alpine \
  pg_basebackup -h <DB_PRIMARY_PRIVATE_IP> -U replicator -D /var/lib/postgresql/data -Fp -Xs -P

# Configure as standby (create standby.signal)
docker exec ems_postgres touch /var/lib/postgresql/data/standby.signal

# Start
docker compose -f docker-compose.db.yml up -d
```

---

## 6. Deploy Worker

```bash
ssh ems@<WORKER_IP>
cd ~/app

# Create .env.prod with RabbitMQ + DB credentials
cat > .env.prod << 'EOF'
DATABASE_URL=postgresql+asyncpg://ems_admin:<DB_PASSWORD>@<DB_PRIMARY_PRIVATE_IP>:6432/ems_automations
CELERY_BROKER_URL=amqp://ems_rabbit:<RABBIT_PASSWORD>@localhost:5672//
SECRET_KEY=<YOUR_SECRET_KEY>
ENCRYPTION_KEY=<YOUR_ENCRYPTION_KEY>
EOF

# Start RabbitMQ + Celery (12 workers) + Flower
docker compose -f docker-compose.worker.yml up -d

# Verify
docker compose -f docker-compose.worker.yml ps
docker exec ems_rabbitmq rabbitmqctl cluster_status
```

Flower is accessible via SSH tunnel only:
```bash
# From your laptop:
ssh -L 5555:localhost:5555 ems@<WORKER_IP>
# Then open http://localhost:5555
```

---

## 7. Deploy App-1 & App-2

```bash
ssh ems@<APP1_IP>
cd ~/app

# Create .env.prod
cat > .env.prod << 'EOF'
APP_ENV=production
DATABASE_URL=postgresql+asyncpg://ems_admin:<DB_PASSWORD>@<DB_PRIMARY_PRIVATE_IP>:6432/ems_automations
CELERY_BROKER_URL=amqp://ems_rabbit:<RABBIT_PASSWORD>@<WORKER_PRIVATE_IP>:5672//
SECRET_KEY=<YOUR_SECRET_KEY>
ENCRYPTION_KEY=<YOUR_ENCRYPTION_KEY>
CORS_ORIGINS=https://app.example.co.za
FRONTEND_URL=https://app.example.co.za
PUBLIC_APP_URL=https://app.example.co.za
EOF

# Build and start
docker compose -f docker-compose.prod.yml up -d --build

# Verify
curl http://localhost/api/health
```

Repeat for App-2.

---

## 8. Load Balancer

Configure the Hetzner Load Balancer health checks:

```bash
# Health check on /api/health endpoint
hcloud load-balancer update-service ems-lb \
  --listen-port 443 \
  --health-check-protocol http \
  --health-check-port 80 \
  --health-check-path /api/health \
  --health-check-interval 10s \
  --health-check-timeout 5s \
  --health-check-retries 3
```

Point your DNS A record to the Load Balancer IP:
```
app.example.co.za  →  <LOAD_BALANCER_IP>
```

---

## 9. SSL Certificates

On App-1 (the certbot container handles this):
```bash
docker exec ems_certbot certbot certonly --webroot \
  -w /var/www/certbot \
  -d app.example.co.za \
  --email admin@example.co.za \
  --agree-tos --non-interactive

# Reload Nginx to pick up certs
docker exec ems_nginx nginx -s reload
```

Auto-renewal is handled by the certbot container's entrypoint.

---

## 10. Run Migrations

From App-1:
```bash
docker exec ems_backend alembic upgrade head
```

Verify:
```bash
docker exec ems_backend alembic current
# Should show: a3b7c9d1e5f2 (head)
```

---

## 11. Deploy Monitoring

On the Worker server:
```bash
cd ~/app
docker compose -f infra/monitoring/docker-compose.monitoring.yml up -d
```

Access via SSH tunnel:
```bash
# Grafana
ssh -L 3000:localhost:3000 ems@<WORKER_IP>
# Open http://localhost:3000 — default admin/admin

# Prometheus
ssh -L 9090:localhost:9090 ems@<WORKER_IP>

# Uptime Kuma
ssh -L 3001:localhost:3001 ems@<WORKER_IP>
```

Configure Grafana:
1. Add Prometheus data source → `http://prometheus:9090`
2. Import the EMS dashboards from `infra/monitoring/grafana/dashboards/`
3. Configure alert channels (email via Alertmanager)

---

## 12. Verification

### Smoke Tests
```bash
# API health
curl https://app.example.co.za/api/health

# Frontend loads
curl -s https://app.example.co.za | head -5

# Submit a test PRF (requires auth token)
curl -X POST https://app.example.co.za/api/digital-prf \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
```

### Load Test (shift-change simulation)
```bash
# Install k6 load testing tool
brew install k6

# Run burst test: 900 PRFs over 60 seconds
k6 run --vus 100 --duration 60s infra/loadtest.js
```

### Checklist
- [ ] Both app servers respond behind load balancer
- [ ] PRF submission → Celery processes → billing record created
- [ ] PgBouncer connection pooling active (check `SHOW POOLS` on pgbouncer)
- [ ] Patroni failover: stop primary, verify standby promotes
- [ ] Monitoring: Prometheus scrapes all targets
- [ ] Alertmanager: test email alert fires
- [ ] SSL: certificate valid, auto-renewal scheduled
- [ ] Fail2ban: SSH jail active

---

## 13. Maintenance Runbook

### Rolling Deploy (zero downtime)
```bash
# Deploy to App-1 first
ssh ems@<APP1_IP> "cd ~/app && git pull && docker compose -f docker-compose.prod.yml up -d --build"
# Wait for health check
sleep 10 && curl -f http://<APP1_IP>/api/health

# Then App-2
ssh ems@<APP2_IP> "cd ~/app && git pull && docker compose -f docker-compose.prod.yml up -d --build"
sleep 10 && curl -f http://<APP2_IP>/api/health
```

### Database Backup (manual)
```bash
ssh ems@<DB_PRIMARY_IP>
docker exec ems_postgres pg_dump -U ems_admin ems_automations | gzip > backup_$(date +%Y%m%d).sql.gz
```

### View Celery Queue
```bash
ssh ems@<WORKER_IP>
docker exec ems_rabbitmq rabbitmqctl list_queues name messages consumers
```

### Emergency: Restart Everything
```bash
# On each server:
docker compose -f <compose-file> restart
```

---

## Server Reference

| Server | Type | Private IP | Role | Compose File |
|---|---|---|---|---|
| ems-app-1 | CX32 | 10.0.1.x | FastAPI + Nginx | `docker-compose.prod.yml` |
| ems-app-2 | CX32 | 10.0.1.x | FastAPI + Nginx | `docker-compose.prod.yml` |
| ems-worker | CX42 | 10.0.1.x | Celery + RabbitMQ + Flower | `docker-compose.worker.yml` |
| ems-db-primary | CX42 | 10.0.1.x | PostgreSQL + PgBouncer | `docker-compose.db.yml` |
| ems-db-standby | CX32 | 10.0.1.x | PostgreSQL replica | `docker-compose.db.yml` |
| ems-lb | LB11 | (public) | Load Balancer | Hetzner console |

> **Fill in the private IPs** after provisioning. The `x` values are assigned by Hetzner.

---

*Last updated: May 2026 — Phase 2 deployment*
