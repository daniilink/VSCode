#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# PP Exchange - Deployment Script
# Usage: ./scripts/deploy.sh [--fresh|--update|--ssl]
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
PROJECT_DIR="/var/www/pp-exchange"
BACKEND_DIR="$PROJECT_DIR/backend"
WEBSITE_DIR="$PROJECT_DIR/website"
DOMAINS=("pp.daniilink.com" "api.daniilink.com")

log() { echo -e "${GREEN}[✓]${NC} $1"; }
info() { echo -e "${BLUE}[i]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1" >&2; exit 1; }

# ─────────────────────────────────────────────────────────────
# Helper Functions
# ─────────────────────────────────────────────────────────────

check_root() {
    if [ "$EUID" -ne 0 ]; then
        error "Please run as root (sudo ./scripts/deploy.sh)"
    fi
}

install_dependencies() {
    info "Installing system dependencies..."

    apt update -qq
    apt install -y curl wget git nginx certbot python3-certbot-nginx ufw fail2ban

    # Docker
    if ! command -v docker &> /dev/null; then
        info "Installing Docker..."
        curl -fsSL https://get.docker.com | sh
        systemctl enable docker
        systemctl start docker
    fi

    # Docker Compose
    if ! command -v docker-compose &> /dev/null; then
        info "Installing Docker Compose..."
        curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
        chmod +x /usr/local/bin/docker-compose
    fi

    log "Dependencies installed"
}

setup_firewall() {
    info "Configuring firewall..."

    ufw --force reset
    ufw default deny incoming
    ufw default allow outgoing

    # SSH (change port if needed)
    ufw allow 22/tcp

    # HTTP/HTTPS
    ufw allow 80/tcp
    ufw allow 443/tcp

    ufw --force enable
    log "Firewall configured"
}

setup_fail2ban() {
    info "Configuring fail2ban..."

    cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5
backend = auto

[sshd]
enabled = true

[nginx-http-auth]
enabled = true

[nginx-limit-req]
enabled = true
filter = nginx-limit-req
action = iptables-multiport[name=ReqLimit, port="http,https", protocol=tcp]
logpath = /var/log/nginx/*error.log
findtime = 600
maxretry = 10

[nginx-botsearch]
enabled = true
EOF

    # Custom filter for rate limiting
    cat > /etc/fail2ban/filter.d/nginx-limit-req.conf << 'EOF'
[Definition]
failregex = limiting requests, excess:.* by zone.*client: <HOST>
ignoreregex =
EOF

    systemctl enable fail2ban
    systemctl restart fail2ban
    log "Fail2ban configured"
}

setup_directories() {
    info "Creating directory structure..."

    mkdir -p "$BACKEND_DIR"
    mkdir -p "$WEBSITE_DIR"
    mkdir -p /var/backups/pp-exchange
    mkdir -p /var/www/certbot
    mkdir -p /var/log/pp-exchange

    log "Directories created"
}

copy_files() {
    info "Copying project files..."

    # Get script directory
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    SOURCE_DIR="$(dirname "$SCRIPT_DIR")"

    # Copy backend
    cp -r "$SOURCE_DIR/src" "$BACKEND_DIR/"
    cp "$SOURCE_DIR/package.json" "$BACKEND_DIR/"
    cp "$SOURCE_DIR/package-lock.json" "$BACKEND_DIR/" 2>/dev/null || true
    cp "$SOURCE_DIR/Dockerfile.production" "$BACKEND_DIR/Dockerfile"
    cp "$SOURCE_DIR/docker-compose.production.yml" "$BACKEND_DIR/docker-compose.yml"
    cp -r "$SOURCE_DIR/nginx" "$BACKEND_DIR/"
    cp -r "$SOURCE_DIR/scripts" "$BACKEND_DIR/"

    # Copy website
    cp "$SOURCE_DIR/website/index.html" "$WEBSITE_DIR/"

    # Set permissions
    chmod +x "$BACKEND_DIR/scripts/"*.sh

    log "Files copied"
}

setup_env() {
    ENV_FILE="$BACKEND_DIR/.env"

    if [ -f "$ENV_FILE" ]; then
        warn ".env file already exists, skipping..."
        return
    fi

    info "Creating .env file..."
    echo ""
    echo "Please provide the following configuration values:"
    echo ""

    read -p "Supabase URL: " SUPABASE_URL
    read -p "Supabase Service Key: " SUPABASE_KEY
    read -p "Telegram Bot Token: " TG_TOKEN
    read -p "Telegram Chat ID (for orders): " TG_CHAT
    read -p "Telegram Error Chat ID: " TG_ERROR
    read -p "hCaptcha Secret: " HCAPTCHA
    read -p "Gmail Client ID: " GMAIL_ID
    read -p "Gmail Client Secret: " GMAIL_SECRET
    read -p "Gmail Refresh Token 1: " GMAIL_RT1
    read -p "Gmail Refresh Token 2 (optional): " GMAIL_RT2
    read -p "Gmail Refresh Token 3 (optional): " GMAIL_RT3
    read -p "Google Sheet ID: " SHEET_ID

    cat > "$ENV_FILE" << EOF
# Server
PORT=3000
NODE_ENV=production
BASE_URL=https://api.daniilink.com

# Supabase
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SERVICE_KEY=$SUPABASE_KEY

# Telegram
TELEGRAM_BOT_TOKEN=$TG_TOKEN
TELEGRAM_CHAT_ID=$TG_CHAT
TELEGRAM_ERROR_CHAT_ID=$TG_ERROR

# hCaptcha
HCAPTCHA_SECRET=$HCAPTCHA

# Gmail API
GMAIL_CLIENT_ID=$GMAIL_ID
GMAIL_CLIENT_SECRET=$GMAIL_SECRET
GMAIL_REFRESH_TOKEN_1=$GMAIL_RT1
GMAIL_REFRESH_TOKEN_2=$GMAIL_RT2
GMAIL_REFRESH_TOKEN_3=$GMAIL_RT3

# Screenshot Service (internal Docker network)
SCREENSHOT_SERVICE_URL=http://screenshot-service:3000/screenshot

# PayPal IPN
PAYPAL_IPN_URL=https://ipnpb.paypal.com/cgi-bin/webscr

# Google Sheets
GOOGLE_SHEET_ID=$SHEET_ID
EOF

    chmod 600 "$ENV_FILE"
    log ".env file created (permissions: 600)"
}

setup_nginx() {
    info "Configuring nginx..."

    # Remove default
    rm -f /etc/nginx/sites-enabled/default

    # Copy config
    cp "$BACKEND_DIR/nginx/pp-exchange.production.conf" /etc/nginx/sites-available/pp-exchange.conf

    # Enable site
    ln -sf /etc/nginx/sites-available/pp-exchange.conf /etc/nginx/sites-enabled/

    # Test config (will fail without SSL certs, that's ok)
    nginx -t 2>/dev/null || warn "Nginx config test failed (expected before SSL setup)"

    log "Nginx configured"
}

setup_ssl() {
    info "Setting up SSL certificates..."

    # Temporary config for certbot
    for domain in "${DOMAINS[@]}"; do
        # Create basic config for domain
        cat > "/etc/nginx/sites-available/$domain.temp" << EOF
server {
    listen 80;
    server_name $domain;
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        return 200 'OK';
    }
}
EOF
        ln -sf "/etc/nginx/sites-available/$domain.temp" "/etc/nginx/sites-enabled/"
    done

    nginx -t && systemctl reload nginx

    # Get certificates
    for domain in "${DOMAINS[@]}"; do
        if [ ! -d "/etc/letsencrypt/live/$domain" ]; then
            certbot certonly --webroot -w /var/www/certbot -d "$domain" --non-interactive --agree-tos --email admin@daniilink.com || warn "Failed to get cert for $domain"
        else
            log "Certificate for $domain already exists"
        fi
    done

    # Remove temp configs
    rm -f /etc/nginx/sites-available/*.temp
    rm -f /etc/nginx/sites-enabled/*.temp

    # Reload with full config
    nginx -t && systemctl reload nginx

    log "SSL certificates configured"
}

build_and_start() {
    info "Building and starting containers..."

    cd "$BACKEND_DIR"

    # Build
    docker-compose build --no-cache

    # Start
    docker-compose up -d

    # Wait for health
    sleep 10

    # Check status
    docker-compose ps

    log "Containers started"
}

setup_cron() {
    info "Setting up cron jobs..."

    # Backup cron
    (crontab -l 2>/dev/null | grep -v "pp-exchange"; echo "0 3 * * * $BACKEND_DIR/scripts/backup.sh >> /var/log/pp-exchange/backup.log 2>&1") | crontab -

    # Certbot renewal
    (crontab -l 2>/dev/null | grep -v "certbot"; echo "0 4 * * * certbot renew --quiet && systemctl reload nginx") | crontab -

    log "Cron jobs configured"
}

verify_deployment() {
    info "Verifying deployment..."

    # Health check
    if curl -s http://localhost:3000/health | grep -q "ok"; then
        log "Backend health check: OK"
    else
        error "Backend health check failed!"
    fi

    # External check
    for domain in "${DOMAINS[@]}"; do
        if curl -sI "https://$domain" | grep -q "200\|301\|302"; then
            log "External check for $domain: OK"
        else
            warn "External check for $domain failed (might need DNS)"
        fi
    done
}

print_summary() {
    echo ""
    echo "════════════════════════════════════════════════════════════════"
    echo -e "${GREEN}  PP Exchange Deployment Complete!${NC}"
    echo "════════════════════════════════════════════════════════════════"
    echo ""
    echo "  Website:   https://pp.daniilink.com"
    echo "  API:       https://api.daniilink.com"
    echo ""
    echo "  Useful commands:"
    echo "    cd $BACKEND_DIR"
    echo "    docker-compose logs -f          # View logs"
    echo "    docker-compose restart          # Restart"
    echo "    docker-compose down && docker-compose up -d  # Full restart"
    echo "    ./scripts/backup.sh             # Manual backup"
    echo ""
    echo "  Health check:"
    echo "    curl https://api.daniilink.com/health"
    echo ""
    echo "════════════════════════════════════════════════════════════════"
}

# ─────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────

main() {
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "  PP Exchange - Deployment Script"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""

    check_root

    case "${1:-fresh}" in
        --fresh)
            info "Running fresh installation..."
            install_dependencies
            setup_firewall
            setup_fail2ban
            setup_directories
            copy_files
            setup_env
            setup_nginx
            setup_ssl
            build_and_start
            setup_cron
            verify_deployment
            print_summary
            ;;
        --update)
            info "Updating deployment..."
            copy_files
            cd "$BACKEND_DIR"
            docker-compose build --no-cache
            docker-compose up -d
            verify_deployment
            log "Update complete!"
            ;;
        --ssl)
            info "Setting up SSL only..."
            setup_ssl
            systemctl reload nginx
            log "SSL setup complete!"
            ;;
        *)
            echo "Usage: $0 [--fresh|--update|--ssl]"
            echo "  --fresh  : Full installation (default)"
            echo "  --update : Update code and restart containers"
            echo "  --ssl    : Setup/renew SSL certificates only"
            exit 1
            ;;
    esac
}

main "$@"
