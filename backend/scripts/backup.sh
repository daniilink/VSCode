#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# PP Exchange - Backup Script
# Run: ./scripts/backup.sh
# Cron: 0 3 * * * /var/www/pp-exchange/backend/scripts/backup.sh
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# Configuration
BACKUP_DIR="/var/backups/pp-exchange"
RETENTION_DAYS=30
DATE=$(date +%Y%m%d_%H%M%S)
PROJECT_DIR="/var/www/pp-exchange"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# Create backup directory
mkdir -p "$BACKUP_DIR"

log "Starting backup..."

# ─────────────────────────────────────────────────────────────
# 1. Backup source code and configs
# ─────────────────────────────────────────────────────────────
log "Backing up source code..."
BACKUP_FILE="$BACKUP_DIR/pp-exchange_$DATE.tar.gz"

tar -czf "$BACKUP_FILE" \
    --exclude="node_modules" \
    --exclude=".git" \
    --exclude="*.log" \
    -C "$PROJECT_DIR" \
    backend/src \
    backend/package.json \
    backend/package-lock.json \
    backend/docker-compose*.yml \
    backend/Dockerfile* \
    backend/nginx \
    backend/scripts \
    website 2>/dev/null || true

if [ -f "$BACKUP_FILE" ]; then
    SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    log "Source backup: $BACKUP_FILE ($SIZE)"
else
    error "Failed to create source backup"
fi

# ─────────────────────────────────────────────────────────────
# 2. Backup .env file (encrypted)
# ─────────────────────────────────────────────────────────────
ENV_FILE="$PROJECT_DIR/backend/.env"
if [ -f "$ENV_FILE" ]; then
    log "Backing up environment file..."
    ENV_BACKUP="$BACKUP_DIR/env_$DATE.enc"

    # Check if BACKUP_PASSWORD is set
    if [ -n "${BACKUP_PASSWORD:-}" ]; then
        openssl enc -aes-256-cbc -salt -pbkdf2 \
            -in "$ENV_FILE" \
            -out "$ENV_BACKUP" \
            -pass pass:"$BACKUP_PASSWORD"
        log "Environment backup (encrypted): $ENV_BACKUP"
    else
        # Plain copy with restricted permissions
        cp "$ENV_FILE" "$BACKUP_DIR/env_$DATE.bak"
        chmod 600 "$BACKUP_DIR/env_$DATE.bak"
        warn "Environment backup (unencrypted - set BACKUP_PASSWORD for encryption)"
    fi
fi

# ─────────────────────────────────────────────────────────────
# 3. Backup Docker volumes (if any)
# ─────────────────────────────────────────────────────────────
log "Checking Docker volumes..."
if docker volume ls -q | grep -q "pp-"; then
    for vol in $(docker volume ls -q | grep "pp-"); do
        VOL_BACKUP="$BACKUP_DIR/volume_${vol}_$DATE.tar.gz"
        docker run --rm \
            -v "$vol":/data \
            -v "$BACKUP_DIR":/backup \
            alpine tar -czf "/backup/volume_${vol}_$DATE.tar.gz" -C /data . 2>/dev/null || true

        if [ -f "$VOL_BACKUP" ]; then
            log "Volume backup: $VOL_BACKUP"
        fi
    done
fi

# ─────────────────────────────────────────────────────────────
# 4. Backup nginx configs
# ─────────────────────────────────────────────────────────────
if [ -d "/etc/nginx/sites-available" ]; then
    log "Backing up nginx configs..."
    tar -czf "$BACKUP_DIR/nginx_$DATE.tar.gz" \
        -C /etc/nginx \
        sites-available \
        sites-enabled 2>/dev/null || true
fi

# ─────────────────────────────────────────────────────────────
# 5. Backup SSL certificates
# ─────────────────────────────────────────────────────────────
if [ -d "/etc/letsencrypt" ]; then
    log "Backing up SSL certificates..."
    tar -czf "$BACKUP_DIR/ssl_$DATE.tar.gz" \
        -C /etc \
        letsencrypt 2>/dev/null || true
fi

# ─────────────────────────────────────────────────────────────
# 6. Cleanup old backups
# ─────────────────────────────────────────────────────────────
log "Cleaning up old backups (older than $RETENTION_DAYS days)..."
find "$BACKUP_DIR" -type f -mtime +$RETENTION_DAYS -delete

# ─────────────────────────────────────────────────────────────
# 7. Summary
# ─────────────────────────────────────────────────────────────
echo ""
log "Backup completed!"
echo "────────────────────────────────────────────────────"
echo "Location: $BACKUP_DIR"
echo "Files:"
ls -lh "$BACKUP_DIR"/*_$DATE* 2>/dev/null || echo "  (none)"
echo "────────────────────────────────────────────────────"
echo ""
echo "Total backup size: $(du -sh "$BACKUP_DIR" | cut -f1)"
echo ""

# ─────────────────────────────────────────────────────────────
# Optional: Send notification to Telegram
# ─────────────────────────────────────────────────────────────
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_ERROR_CHAT_ID:-}" ]; then
    TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
    MESSAGE="✅ PP Exchange Backup Complete%0A%0ADate: $DATE%0ATotal size: $TOTAL_SIZE"

    curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage?chat_id=$TELEGRAM_ERROR_CHAT_ID&text=$MESSAGE" > /dev/null 2>&1 || true
fi
