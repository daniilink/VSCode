#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# PP Exchange - Monitoring Script
# Usage: ./scripts/monitor.sh [--watch]
# ═══════════════════════════════════════════════════════════════

BACKEND_DIR="/var/www/pp-exchange/backend"
API_URL="${API_URL:-http://localhost:3000}"
WATCH_MODE="${1:-}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

check_health() {
    if curl -sf "$API_URL/health" > /dev/null 2>&1; then
        echo -e "${GREEN}●${NC} Backend: UP"
    else
        echo -e "${RED}●${NC} Backend: DOWN"
    fi
}

check_containers() {
    echo ""
    echo "Docker Containers:"
    echo "─────────────────────────────────────────────────────"

    if command -v docker &> /dev/null; then
        docker ps --filter "name=pp-" --format "  {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "  (docker not running)"
    else
        echo "  (docker not installed)"
    fi
}

check_resources() {
    echo ""
    echo "Resource Usage:"
    echo "─────────────────────────────────────────────────────"

    if command -v docker &> /dev/null; then
        docker stats --no-stream --format "  {{.Name}}\tCPU: {{.CPUPerc}}\tMem: {{.MemUsage}}" \
            $(docker ps -q --filter "name=pp-" 2>/dev/null) 2>/dev/null || echo "  (no containers)"
    fi
}

check_logs() {
    echo ""
    echo "Recent Errors (last 10):"
    echo "─────────────────────────────────────────────────────"

    if [ -d "$BACKEND_DIR" ]; then
        cd "$BACKEND_DIR"
        docker-compose logs --tail=50 pp-backend 2>/dev/null | grep -i "error\|warn" | tail -10 || echo "  (no recent errors)"
    fi
}

check_disk() {
    echo ""
    echo "Disk Usage:"
    echo "─────────────────────────────────────────────────────"
    df -h / /var 2>/dev/null | grep -v "^Filesystem" | awk '{print "  " $6 ": " $3 "/" $2 " (" $5 ")"}'
}

check_ssl() {
    echo ""
    echo "SSL Certificates:"
    echo "─────────────────────────────────────────────────────"

    for domain in pp.daniilink.com api.daniilink.com; do
        CERT_PATH="/etc/letsencrypt/live/$domain/fullchain.pem"
        if [ -f "$CERT_PATH" ]; then
            EXPIRY=$(openssl x509 -enddate -noout -in "$CERT_PATH" 2>/dev/null | cut -d= -f2)
            DAYS_LEFT=$(( ($(date -d "$EXPIRY" +%s) - $(date +%s)) / 86400 ))

            if [ $DAYS_LEFT -lt 14 ]; then
                echo -e "  ${RED}$domain: $DAYS_LEFT days left${NC}"
            elif [ $DAYS_LEFT -lt 30 ]; then
                echo -e "  ${YELLOW}$domain: $DAYS_LEFT days left${NC}"
            else
                echo -e "  ${GREEN}$domain: $DAYS_LEFT days left${NC}"
            fi
        else
            echo -e "  ${RED}$domain: no certificate${NC}"
        fi
    done
}

display() {
    clear
    echo "═══════════════════════════════════════════════════════════════"
    echo "  PP Exchange - System Monitor"
    echo "  $(date '+%Y-%m-%d %H:%M:%S')"
    echo "═══════════════════════════════════════════════════════════════"

    check_health
    check_containers
    check_resources
    check_disk
    check_ssl

    if [ "$WATCH_MODE" != "--watch" ]; then
        check_logs
    fi

    echo ""
    echo "═══════════════════════════════════════════════════════════════"
}

if [ "$WATCH_MODE" = "--watch" ]; then
    while true; do
        display
        sleep 5
    done
else
    display
fi
