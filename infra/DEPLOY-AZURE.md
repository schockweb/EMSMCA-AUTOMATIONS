# EMS Digital PRF — Azure South Africa Deployment Guide

> **Target:** Azure South Africa North (Johannesburg)
> **Stack:** Docker Compose on Azure VM + Azure Database for PostgreSQL
> **POPIA:** ✅ All data stays in SA datacentre

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Azure South Africa North (Johannesburg)            │
│                                                     │
│  ┌──────────────┐      ┌─────────────────────────┐  │
│  │  Azure DNS   │─────▶│  VM: Standard_B4ms      │  │
│  │  + SSL cert  │      │  ┌───────────────────┐  │  │
│  └──────────────┘      │  │ Nginx (reverse    │  │  │
│                        │  │ proxy + SSL)      │  │  │
│                        │  ├───────────────────┤  │  │
│                        │  │ Backend (FastAPI)  │  │  │
│                        │  │ Frontend (Vite)    │  │  │
│                        │  │ Celery Worker      │  │  │
│                        │  │ RabbitMQ           │  │  │
│                        │  └───────────────────┘  │  │
│                        └────────────┬────────────┘  │
│                                     │ VNet          │
│                        ┌────────────▼────────────┐  │
│                        │ Azure Database for      │  │
│                        │ PostgreSQL Flexible     │  │
│                        │ (Burstable B2ms)        │  │
│                        └─────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

> **Why this layout?** Using Azure Managed PostgreSQL gives you automated backups,
> point-in-time restore, and HA failover without managing replicas yourself.
> Everything else runs on a single VM via Docker Compose — simple and cheap.

---

## Estimated Monthly Cost

| Resource | SKU | Cost (ZAR) |
|---|---|---|
| VM | Standard_B4ms (4 vCPU, 16 GB) | ~R2,100 |
| Managed PostgreSQL | Burstable B2ms (2 vCPU, 4 GB, 32 GB storage) | ~R1,200 |
| Managed Disk | 64 GB Premium SSD (OS) | ~R180 |
| Static IP | 1 public IP | ~R70 |
| Bandwidth | 5 GB/month outbound (South Africa) | ~R50 |
| **Total** | | **~R3,600/mo** |

> 💡 If the client has Azure Reserved Instances or Hybrid Benefit, this drops 30-40%.

---

## Prerequisites

- [ ] Azure subscription with contributor access
- [ ] Azure CLI installed (`winget install Microsoft.AzureCLI`)
- [ ] SSH key pair: `ssh-keygen -t ed25519 -f ~/.ssh/ems_azure`
- [ ] Domain name ready (e.g. `app.jems.co.za`)
- [ ] Git repo accessible from the VM

```powershell
# Login to Azure
az login

# Set the subscription (ask client for subscription ID)
az account set --subscription "<SUBSCRIPTION_ID>"
```

---

## Step 1: Create Resource Group

```bash
az group create \
  --name rg-ems-prod \
  --location southafricanorth
```

---

## Step 2: Create Virtual Network

```bash
# VNet for the VM + Database
az network vnet create \
  --resource-group rg-ems-prod \
  --name vnet-ems \
  --address-prefix 10.0.0.0/16 \
  --subnet-name snet-app \
  --subnet-prefix 10.0.1.0/24 \
  --location southafricanorth

# Subnet for PostgreSQL (delegated)
az network vnet subnet create \
  --resource-group rg-ems-prod \
  --vnet-name vnet-ems \
  --name snet-db \
  --address-prefixes 10.0.2.0/24 \
  --delegations "Microsoft.DBforPostgreSQL/flexibleServers"

# Private DNS zone for PostgreSQL
az network private-dns zone create \
  --resource-group rg-ems-prod \
  --name ems.private.postgres.database.azure.com

az network private-dns zone vnet-link create \
  --resource-group rg-ems-prod \
  --zone-name ems.private.postgres.database.azure.com \
  --name vnet-link-ems \
  --virtual-network vnet-ems \
  --registration-enabled false
```

---

## Step 3: Create Azure Database for PostgreSQL

```bash
az postgres flexible-server create \
  --resource-group rg-ems-prod \
  --name ems-db-prod \
  --location southafricanorth \
  --admin-user ems_admin \
  --admin-password '<STRONG_PASSWORD_HERE>' \
  --sku-name Standard_B2ms \
  --tier Burstable \
  --storage-size 32 \
  --version 16 \
  --vnet vnet-ems \
  --subnet snet-db \
  --private-dns-zone ems.private.postgres.database.azure.com \
  --yes

# Create the database
az postgres flexible-server db create \
  --resource-group rg-ems-prod \
  --server-name ems-db-prod \
  --database-name ems_claims

# Enable pgcrypto extension (used by UUID columns)
az postgres flexible-server parameter set \
  --resource-group rg-ems-prod \
  --server-name ems-db-prod \
  --name azure.extensions \
  --value "UUID-OSSP,PGCRYPTO"

# Configure for EMS workload
az postgres flexible-server parameter set \
  --resource-group rg-ems-prod \
  --server-name ems-db-prod \
  --name max_connections \
  --value 200

az postgres flexible-server parameter set \
  --resource-group rg-ems-prod \
  --server-name ems-db-prod \
  --name work_mem \
  --value "8192"
```

**Take note of the connection hostname:**
```
ems-db-prod.postgres.database.azure.com
```
(But since we're on VNet, the private endpoint resolves via the private DNS zone.)

---

## Step 4: Create the VM

```bash
# Create Network Security Group
az network nsg create \
  --resource-group rg-ems-prod \
  --name nsg-ems-app \
  --location southafricanorth

# Allow SSH (restrict to your IP in production)
az network nsg rule create \
  --resource-group rg-ems-prod \
  --nsg-name nsg-ems-app \
  --name AllowSSH \
  --priority 100 \
  --source-address-prefixes '<YOUR_IP>/32' \
  --destination-port-ranges 22 \
  --protocol Tcp \
  --access Allow

# Allow HTTP/HTTPS
az network nsg rule create \
  --resource-group rg-ems-prod \
  --nsg-name nsg-ems-app \
  --name AllowHTTPS \
  --priority 110 \
  --source-address-prefixes '*' \
  --destination-port-ranges 80 443 \
  --protocol Tcp \
  --access Allow

# Create the VM
az vm create \
  --resource-group rg-ems-prod \
  --name vm-ems-app \
  --location southafricanorth \
  --image Ubuntu2404 \
  --size Standard_B4ms \
  --admin-username emsadmin \
  --ssh-key-values ~/.ssh/ems_azure.pub \
  --vnet-name vnet-ems \
  --subnet snet-app \
  --nsg nsg-ems-app \
  --public-ip-address ip-ems-app \
  --public-ip-sku Standard \
  --os-disk-size-gb 64 \
  --storage-sku Premium_LRS

# Get the public IP
az vm show \
  --resource-group rg-ems-prod \
  --name vm-ems-app \
  --show-details \
  --query publicIps \
  --output tsv
```

---

## Step 5: Setup the VM

```bash
# SSH in
ssh emsadmin@<VM_PUBLIC_IP>

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo systemctl enable docker
sudo usermod -aG docker $USER

# Install Docker Compose plugin
sudo apt install -y docker-compose-plugin

# Log out and back in for docker group to take effect
exit
ssh emsadmin@<VM_PUBLIC_IP>

# Clone the repo
git clone https://github.com/<YOUR_ORG>/ems-automations.git ~/app
cd ~/app
```

---

## Step 6: Create Production Environment File

```bash
cat > ~/app/.env.prod << 'EOF'
# === App ===
APP_ENV=production

# === Database (Azure Managed PostgreSQL) ===
# The hostname resolves via VNet private DNS
DATABASE_URL=postgresql+asyncpg://ems_admin:<DB_PASSWORD>@ems-db-prod.postgres.database.azure.com:5432/ems_claims?ssl=require
POSTGRES_SSL=require

# === RabbitMQ (runs on this VM) ===
CELERY_BROKER_URL=amqp://ems_rabbit:<RABBIT_PASSWORD>@rabbitmq:5672//
RABBITMQ_USER=ems_rabbit
RABBITMQ_PASS=<RABBIT_PASSWORD>

# === Security ===
SECRET_KEY=<GENERATE: python3 -c "import secrets; print(secrets.token_hex(32))">
ENCRYPTION_KEY=<GENERATE: python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())">

# === CORS (your domain) ===
CORS_ORIGINS=https://app.jems.co.za
FRONTEND_URL=https://app.jems.co.za
PUBLIC_APP_URL=https://app.jems.co.za
EOF

chmod 600 ~/app/.env.prod
```

---

## Step 7: Create Production Docker Compose

```bash
cat > ~/app/docker-compose.prod.yml << 'YAML'
services:
  rabbitmq:
    image: rabbitmq:3.13-management-alpine
    container_name: ems_rabbitmq
    restart: always
    environment:
      RABBITMQ_DEFAULT_USER: ${RABBITMQ_USER}
      RABBITMQ_DEFAULT_PASS: ${RABBITMQ_PASS}
    ports:
      - "127.0.0.1:5672:5672"
      - "127.0.0.1:15672:15672"
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "check_running"]
      interval: 10s
      timeout: 10s
      retries: 5

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    container_name: ems_backend
    restart: always
    env_file:
      - .env.prod
    ports:
      - "127.0.0.1:8000:8000"
    volumes:
      - upload_data:/app/uploads
    depends_on:
      rabbitmq:
        condition: service_healthy
    command: >
      uvicorn app.main:app
        --host 0.0.0.0
        --port 8000
        --workers 4
        --limit-concurrency 200
        --timeout-keep-alive 30

  celery_worker:
    build:
      context: ./backend
      dockerfile: Dockerfile
    container_name: ems_celery_worker
    restart: always
    env_file:
      - .env.prod
    volumes:
      - upload_data:/app/uploads
    depends_on:
      rabbitmq:
        condition: service_healthy
    command: >
      celery -A app.tasks.celery_app worker
        --loglevel=info
        --concurrency=8
        --pool=prefork
        --max-tasks-per-child=100

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    container_name: ems_frontend
    restart: always
    ports:
      - "127.0.0.1:3000:80"

  nginx:
    image: nginx:alpine
    container_name: ems_nginx
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./infra/nginx/prod.conf:/etc/nginx/conf.d/default.conf:ro
      - certbot_certs:/etc/letsencrypt:ro
      - certbot_www:/var/www/certbot:ro
    depends_on:
      - backend
      - frontend

  certbot:
    image: certbot/certbot
    container_name: ems_certbot
    volumes:
      - certbot_certs:/etc/letsencrypt
      - certbot_www:/var/www/certbot
    entrypoint: "/bin/sh -c 'trap exit TERM; while :; do certbot renew; sleep 12h; done'"

volumes:
  rabbitmq_data:
  upload_data:
  certbot_certs:
  certbot_www:
YAML
```

---

## Step 8: Create Production Nginx Config

```bash
cat > ~/app/infra/nginx/prod.conf << 'NGINX'
# HTTP → HTTPS redirect + Let's Encrypt challenge
server {
    listen 80;
    server_name app.jems.co.za;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS
server {
    listen 443 ssl http2;
    server_name app.jems.co.za;

    ssl_certificate     /etc/letsencrypt/live/app.jems.co.za/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.jems.co.za/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Security headers
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # API
    location /api/ {
        proxy_pass http://backend:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        client_max_body_size 25M;
    }

    # Prometheus metrics (no auth — restrict by IP or use internal only)
    location /api/metrics {
        proxy_pass http://backend:8000;
        # Uncomment to restrict to monitoring server only:
        # allow 10.0.0.0/16;
        # deny all;
    }

    # Health check (public for Azure LB)
    location /health {
        proxy_pass http://backend:8000;
    }

    # Frontend
    location / {
        proxy_pass http://frontend:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
NGINX
```

---

## Step 9: Get SSL Certificate

```bash
cd ~/app

# First start without SSL (so certbot can answer the challenge)
# Temporarily use a minimal nginx config that just serves HTTP
docker compose -f docker-compose.prod.yml up -d nginx

# Get the certificate
docker run --rm \
  -v ems_certbot_certs:/etc/letsencrypt \
  -v ems_certbot_www:/var/www/certbot \
  certbot/certbot certonly --webroot \
  -w /var/www/certbot \
  -d app.jems.co.za \
  --email admin@jems.co.za \
  --agree-tos --non-interactive

# Now bring up everything
docker compose -f docker-compose.prod.yml up -d
```

---

## Step 10: Run Migrations

```bash
# Run Alembic inside the backend container
docker exec ems_backend alembic upgrade head

# Verify
docker exec ems_backend alembic current
# Expected: b4c8d2e6f7a3 (head)
```

---

## Step 11: DNS Setup

Point your domain to the VM's public IP:

```
app.jems.co.za    A    <VM_PUBLIC_IP>
```

If the client uses Azure DNS:
```bash
az network dns record-set a add-record \
  --resource-group rg-ems-prod \
  --zone-name jems.co.za \
  --record-set-name app \
  --ipv4-address <VM_PUBLIC_IP>
```

---

## Step 12: Verify Deployment

```bash
# Health check
curl https://app.jems.co.za/health

# API responds
curl https://app.jems.co.za/api/stats

# Metrics endpoint
curl https://app.jems.co.za/api/metrics

# Frontend loads
curl -sI https://app.jems.co.za | head -5
```

---

## Backups (Automated by Azure)

Azure Database for PostgreSQL Flexible Server provides:
- **Automated daily backups** (retained for 7 days by default)
- **Point-in-time restore** (any second in the last 7 days)
- **Geo-redundant backup** (optional, for disaster recovery)

Configure backup retention:
```bash
az postgres flexible-server update \
  --resource-group rg-ems-prod \
  --name ems-db-prod \
  --backup-retention 14
```

---

## Monitoring

### Option A: Use Azure Monitor (Included)
```bash
# Enable VM monitoring
az vm diagnostics set \
  --resource-group rg-ems-prod \
  --vm-name vm-ems-app

# Enable PostgreSQL metrics
# → Already included with Flexible Server (Azure Portal → Metrics)
```

### Option B: Use Prometheus + Grafana (Self-Hosted)
Your `/api/metrics` endpoint is already running. Add Prometheus on the VM:
```bash
docker compose -f infra/monitoring/docker-compose.monitoring.yml up -d

# Access via SSH tunnel:
ssh -L 3000:localhost:3000 emsadmin@<VM_PUBLIC_IP>
# Open http://localhost:3000
```

---

## Scaling Guide

| Milestone | Action | Cost Change |
|---|---|---|
| 500+ ambulances | Upgrade VM to Standard_B8ms (8 vCPU, 32 GB) | +R2,100/mo |
| 1000+ ambulances | Add second VM + Azure Load Balancer | +R3,000/mo |
| Need HA database | Enable HA on PostgreSQL Flexible Server | +R1,200/mo |
| File storage grows | Add Azure Blob Storage for uploads | Pay per GB |

---

## Emergency Runbook

```bash
# Restart all services
ssh emsadmin@<VM_PUBLIC_IP>
cd ~/app
docker compose -f docker-compose.prod.yml restart

# View logs
docker logs ems_backend --tail 100 -f
docker logs ems_celery_worker --tail 100 -f

# Database connection test
docker exec ems_backend python -c "
from app.database import engine
import asyncio
async def test():
    async with engine.connect() as c:
        r = await c.execute('SELECT 1')
        print('DB OK:', r.scalar())
asyncio.run(test())
"

# Celery queue check
docker exec ems_rabbitmq rabbitmqctl list_queues name messages consumers

# Force reprocess stuck PRFs
docker exec ems_backend python -c "
from app.tasks.prf_processing import process_prf_submission
process_prf_submission.delay('<PRF_ID>')
"
```

---

*Last updated: May 2026 — Azure South Africa deployment*
