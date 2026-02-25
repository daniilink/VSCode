# PP Exchange - Production Deployment Guide

## Quick Start (TL;DR)

```bash
# 1. Clone and enter directory
git clone https://github.com/daniilink/VSCode.git /var/www/pp-exchange
cd /var/www/pp-exchange/pp-backend

# 2. Run deployment script
chmod +x scripts/deploy.sh
sudo ./scripts/deploy.sh --fresh

# 3. Follow prompts to enter credentials
```

---

## What's Included

| Service | Port | Description |
|---------|------|-------------|
| pp-backend | 3000 (internal) | Main API |
| screenshot-service | internal | Puppeteer for screenshots |
| pp-website | 8080 (internal) | Static website |
| nginx | 80, 443 | Reverse proxy |

---

## Pre-Requirements

### 1. VPS Requirements
- **OS**: Ubuntu 22.04+
- **RAM**: 1GB minimum (2GB recommended)
- **CPU**: 1 vCPU
- **Disk**: 10GB+

### 2. Domain Setup
Point these domains to your VPS IP:
- `pp.daniilink.com` → Website
- `api.daniilink.com` → API Backend

### 3. External Services
You'll need credentials for:
- **Supabase**: Database (URL + Service Key)
- **Telegram**: Bot Token + Chat IDs
- **hCaptcha**: Site Key + Secret
- **Gmail API**: OAuth credentials + Refresh Tokens
- **Google Sheets**: Sheet ID

---

## Step-by-Step Manual Deploy

### 1. System Preparation

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install dependencies
sudo apt install -y curl wget git nginx certbot python3-certbot-nginx ufw fail2ban

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Re-login for docker group
exit
```

### 2. Clone Project

```bash
git clone https://github.com/daniilink/VSCode.git /var/www/pp-exchange
cd /var/www/pp-exchange/pp-backend
```

### 3. Create Environment File

```bash
cp .env.example .env
nano .env
```

Fill in all values:

```env
# Server
PORT=3000
NODE_ENV=production
BASE_URL=https://api.daniilink.com

# Supabase
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_KEY=eyJ...

# Telegram
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=-100123456789
TELEGRAM_ERROR_CHAT_ID=-100123456789

# hCaptcha
HCAPTCHA_SECRET=0x...

# Gmail API
GMAIL_CLIENT_ID=123456.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-...
GMAIL_REFRESH_TOKEN_1=1//...
GMAIL_REFRESH_TOKEN_2=1//...
GMAIL_REFRESH_TOKEN_3=1//...

# Screenshot (Docker internal)
SCREENSHOT_SERVICE_URL=http://screenshot-service:3000/screenshot

# PayPal
PAYPAL_IPN_URL=https://ipnpb.paypal.com/cgi-bin/webscr

# Google Sheets
GOOGLE_SHEET_ID=1ed_jRmVJkq...
```

**Secure the file:**
```bash
chmod 600 .env
```

### 4. Build and Start

```bash
# Use production compose file
cp docker-compose.production.yml docker-compose.yml
cp Dockerfile.production Dockerfile

# Build and start
docker-compose up -d --build

# Check status
docker-compose ps
docker-compose logs -f
```

### 5. Setup SSL

```bash
# Get certificates
sudo certbot certonly --standalone -d pp.daniilink.com -d api.daniilink.com

# Or with nginx running:
sudo certbot --nginx -d pp.daniilink.com -d api.daniilink.com
```

### 6. Configure Nginx

```bash
# Copy production config
sudo cp nginx/pp-exchange.production.conf /etc/nginx/sites-available/pp-exchange.conf

# Enable site
sudo ln -sf /etc/nginx/sites-available/pp-exchange.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# Test and reload
sudo nginx -t
sudo systemctl reload nginx
```

### 7. Setup Firewall

```bash
sudo ufw allow 22/tcp   # SSH
sudo ufw allow 80/tcp   # HTTP
sudo ufw allow 443/tcp  # HTTPS
sudo ufw enable
```

### 8. Setup Database

Go to Supabase Dashboard → SQL Editor and run:
```sql
-- Copy contents of supabase/migrations/001_initial_schema.sql
```

### 9. Verify Deployment

```bash
# Health check
curl https://api.daniilink.com/health

# Test endpoints
./scripts/test-endpoints.sh production

# Check logs
docker-compose logs -f pp-backend
```

---

## Maintenance

### View Logs
```bash
cd /var/www/pp-exchange/pp-backend
docker-compose logs -f pp-backend
docker-compose logs -f screenshot-service
```

### Restart Services
```bash
docker-compose restart
# or full rebuild:
docker-compose down && docker-compose up -d --build
```

### Update Code
```bash
git pull
docker-compose up -d --build
```

### Manual Backup
```bash
./scripts/backup.sh
```

### Monitor System
```bash
./scripts/monitor.sh --watch
```

---

## Cron Jobs (Auto-configured by deploy script)

| Schedule | Command | Purpose |
|----------|---------|---------|
| 03:00 daily | backup.sh | Backup data |
| 04:00 daily | certbot renew | Renew SSL |

---

## Security Checklist

- [x] Containers run as non-root
- [x] .env file is 600 permissions
- [x] Rate limiting on all endpoints
- [x] fail2ban protects against brute force
- [x] UFW firewall enabled
- [x] SSL/TLS configured with modern ciphers
- [x] HSTS enabled
- [x] Security headers configured
- [x] hCaptcha protects form
- [x] Honeypot field in form
- [x] PayPal IPN verified with PayPal servers

---

## Troubleshooting

### Container won't start
```bash
docker-compose logs pp-backend
# Check .env file for missing values
```

### 502 Bad Gateway
```bash
# Check if backend is running
curl http://localhost:3000/health
docker-compose ps
docker-compose restart
```

### SSL Issues
```bash
# Renew certificates
sudo certbot renew --dry-run
sudo certbot renew
sudo systemctl reload nginx
```

### Gmail API Errors
```bash
# Refresh tokens may have expired
# Re-generate at https://developers.google.com/oauthplayground
```

### No Telegram notifications
```bash
# Test bot
curl "https://api.telegram.org/bot<TOKEN>/getMe"
# Check chat ID is correct (including - for groups)
```

---

## Architecture

```
Internet
    │
    ▼
┌─────────────────────────────────────────┐
│  Nginx (reverse proxy)                  │
│  - SSL termination                      │
│  - Rate limiting                        │
│  - Static files                         │
└─────────────────────────────────────────┘
    │               │
    ▼               ▼
┌─────────┐   ┌─────────────┐
│ Website │   │ pp-backend  │──────┐
│ (8080)  │   │ (3000)      │      │
└─────────┘   └─────────────┘      │
                    │              │
                    ▼              ▼
           ┌────────────┐   ┌──────────┐
           │ Screenshot │   │ Supabase │
           │ Service    │   │ (cloud)  │
           └────────────┘   └──────────┘
```

---

## Support

For issues: https://github.com/daniilink/VSCode/issues
