#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# backup-ems.sh — nightly backup of the EMS portal DB + uploads volume.
# Target: the VM. Version-controlled source of truth for /opt/ems/backup_ems.sh.
#
# Install on the VM:
#   sudo cp deploy/scripts/backup-ems.sh /opt/ems/backup_ems.sh
#   sudo chmod 700 /opt/ems/backup_ems.sh
#   echo "0 2 * * * root /opt/ems/backup_ems.sh >> /var/log/ems-backup.log 2>&1" \
#     | sudo tee /etc/cron.d/ems-backup
#
# Tiered retention: dailies kept 14 days; the first backup of each calendar
# month kept 7 years (medical-record retention). Reads DB creds from .env.prod.
#
# ⚠️ Backups land on the SAME VM (/opt/backups). For true durability, also copy
#    /opt/backups to off-box storage (Azure Blob) — see deploy/README.md.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
ENV=/opt/ems/.env.prod
BACKUP_ROOT=/opt/backups
DB_DIR=$BACKUP_ROOT/db
UP_DIR=$BACKUP_ROOT/uploads
MONTHLY_DIR=$BACKUP_ROOT/monthly
DAILY_RETENTION_DAYS=14
MONTHLY_RETENTION_DAYS=2557   # ~7 years

mkdir -p "$DB_DIR" "$UP_DIR" "$MONTHLY_DIR"
chmod 700 "$BACKUP_ROOT" "$DB_DIR" "$UP_DIR" "$MONTHLY_DIR"

PGUSER=$(grep -oP "^POSTGRES_USER=\K.*" "$ENV")
PGPASSWORD=$(grep -oP "^POSTGRES_PASSWORD=\K.*" "$ENV")
PGDATABASE=$(grep -oP "^POSTGRES_DB=\K.*" "$ENV")
PGHOST=$(grep -oP "^DATABASE_URL=[^@]*@\K[^/:]+" "$ENV")
STAMP=$(date +%Y%m%d_%H%M%S)
MONTH=$(date +%Y%m)

# 1. Database dump — Azure PostgreSQL Flexible Server (v18), SSL required.
#    Write to .tmp and rename on success so a failed run never leaves a
#    plausible-looking empty backup behind.
OUT="$DB_DIR/ems_${PGDATABASE}_${STAMP}.sql.gz"
docker run --rm -e PGPASSWORD="$PGPASSWORD" -e PGSSLMODE=require postgres:18-alpine \
  pg_dump -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" --no-owner | gzip > "$OUT.tmp" \
  && mv "$OUT.tmp" "$OUT" || { rm -f "$OUT.tmp"; echo "DB dump FAILED" >&2; exit 1; }
chmod 600 "$OUT"

# 2. Uploads volume (PRF attachments / logos)
UPOUT="$UP_DIR/uploads_${STAMP}.tar.gz"
docker run --rm -v ems_upload_data:/data:ro -v "$UP_DIR":/backup alpine \
  tar czf "/backup/uploads_${STAMP}.tar.gz" -C /data .
chmod 600 "$UPOUT"

# 3. Monthly long-term copy — first successful run of each calendar month
if ! ls "$MONTHLY_DIR"/ems_${PGDATABASE}_${MONTH}*.sql.gz >/dev/null 2>&1; then
  cp -p "$OUT" "$MONTHLY_DIR/"
  cp -p "$UPOUT" "$MONTHLY_DIR/"
fi

# 4. Rotate
find "$DB_DIR"      -name "*.sql.gz" -mtime +$DAILY_RETENTION_DAYS   -delete
find "$UP_DIR"      -name "*.tar.gz" -mtime +$DAILY_RETENTION_DAYS   -delete
find "$MONTHLY_DIR" -type f          -mtime +$MONTHLY_RETENTION_DAYS -delete

echo "$(date -Is) backup OK: $(du -h "$OUT" | cut -f1) db, $(du -h "$UPOUT" | cut -f1) uploads"
