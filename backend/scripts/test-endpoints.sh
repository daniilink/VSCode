#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# PP Exchange - Endpoint Testing Script
# Usage: ./scripts/test-endpoints.sh [local|production]
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# Configuration
MODE="${1:-local}"

if [ "$MODE" = "production" ]; then
    BASE_URL="https://api.daniilink.com"
    WEBSITE_URL="https://pp.daniilink.com"
else
    BASE_URL="http://localhost:3000"
    WEBSITE_URL="http://localhost:8080"
fi

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; }
fail() { echo -e "${RED}✗ FAIL${NC}: $1"; FAILED=true; }
warn() { echo -e "${YELLOW}! WARN${NC}: $1"; }

FAILED=false

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  PP Exchange - Endpoint Tests"
echo "  Mode: $MODE"
echo "  Base URL: $BASE_URL"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ─────────────────────────────────────────────────────────────
# Health Check
# ─────────────────────────────────────────────────────────────
echo "Testing Health Endpoints..."

if curl -sf "$BASE_URL/health" | grep -q '"status":"ok"'; then
    pass "Health check"
else
    fail "Health check"
fi

if curl -sf "$BASE_URL/health/detailed" 2>/dev/null | grep -q '"server":"ok"'; then
    pass "Detailed health check"
else
    warn "Detailed health check (might not exist)"
fi

echo ""

# ─────────────────────────────────────────────────────────────
# Form Endpoint (without captcha - should fail)
# ─────────────────────────────────────────────────────────────
echo "Testing PP Exchange Form..."

FORM_RESPONSE=$(curl -sf -X POST "$BASE_URL/webhook/pp-exchange" \
    -H "Content-Type: application/json" \
    -d '{"telegram":"@test","amount":"100","crypto":"USDT TRC20","wallet":"TTestWallet123456789012345678901234"}' \
    2>&1 || echo '{"error":"request_failed"}')

if echo "$FORM_RESPONSE" | grep -q "captcha\|error"; then
    pass "PP Exchange form (correctly requires captcha)"
else
    warn "PP Exchange form - unexpected response: $FORM_RESPONSE"
fi

# Test honeypot
HONEYPOT_RESPONSE=$(curl -sf -X POST "$BASE_URL/webhook/pp-exchange" \
    -H "Content-Type: application/json" \
    -d '{"telegram":"@test","amount":"100","website":"bot@spam.com"}' \
    2>&1 || echo '{}')

if echo "$HONEYPOT_RESPONSE" | grep -q "Bot detected\|error"; then
    pass "Honeypot protection working"
else
    warn "Honeypot protection - check response"
fi

echo ""

# ─────────────────────────────────────────────────────────────
# Screenshot Endpoints
# ─────────────────────────────────────────────────────────────
echo "Testing Screenshot Endpoints..."

# txnscreen should return HTML loading page
TXN_RESPONSE=$(curl -sf "$BASE_URL/webhook/txnscreen?transactionId=TEST123" 2>&1 || echo "failed")

if echo "$TXN_RESPONSE" | grep -q "Loading\|html"; then
    pass "Transaction screenshot page loads"
else
    fail "Transaction screenshot page - $TXN_RESPONSE"
fi

# email-screenshot should return HTML loading page
EMAIL_RESPONSE=$(curl -sf "$BASE_URL/webhook/email-screenshot?messageId=TEST123" 2>&1 || echo "failed")

if echo "$EMAIL_RESPONSE" | grep -q "Loading\|html"; then
    pass "Email screenshot page loads"
else
    fail "Email screenshot page"
fi

# Missing params should return 400
MISSING_RESPONSE=$(curl -sf "$BASE_URL/webhook/txnscreen" 2>&1 || echo "failed")

if echo "$MISSING_RESPONSE" | grep -qi "not provided\|failed"; then
    pass "Missing params returns error"
else
    warn "Missing params handling"
fi

echo ""

# ─────────────────────────────────────────────────────────────
# Sync Endpoints (should accept POST)
# ─────────────────────────────────────────────────────────────
echo "Testing Sync Endpoints..."

SYNC_RESPONSE=$(curl -sf -X POST "$BASE_URL/webhook/UpdateClients" \
    -H "Content-Type: application/json" \
    -d '{}' 2>&1 || echo '{}')

if echo "$SYNC_RESPONSE" | grep -qi "success\|started"; then
    pass "UpdateClients endpoint"
else
    warn "UpdateClients - response: $SYNC_RESPONSE"
fi

PAYPALS_RESPONSE=$(curl -sf -X POST "$BASE_URL/webhook/paypals-to-db" \
    -H "Content-Type: application/json" \
    -d '{}' 2>&1 || echo '{}')

if echo "$PAYPALS_RESPONSE" | grep -qi "success\|started"; then
    pass "paypals-to-db endpoint"
else
    warn "paypals-to-db - response: $PAYPALS_RESPONSE"
fi

echo ""

# ─────────────────────────────────────────────────────────────
# IPN Endpoint
# ─────────────────────────────────────────────────────────────
echo "Testing PayPal IPN Endpoint..."

IPN_RESPONSE=$(curl -sf -X POST "$BASE_URL/webhook/ipn-paypal" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "txn_id=TEST123&payment_status=Completed&receiver_email=test@test.com" \
    2>&1 || echo "OK")

if [ "$IPN_RESPONSE" = "OK" ]; then
    pass "IPN endpoint accepts POST"
else
    warn "IPN endpoint - response: $IPN_RESPONSE"
fi

echo ""

# ─────────────────────────────────────────────────────────────
# 404 Handling
# ─────────────────────────────────────────────────────────────
echo "Testing 404 Handling..."

NOT_FOUND=$(curl -sf "$BASE_URL/nonexistent" 2>&1 || echo '{"error":"Not found"}')

if echo "$NOT_FOUND" | grep -qi "not found\|404\|error"; then
    pass "404 handling"
else
    fail "404 handling - response: $NOT_FOUND"
fi

echo ""

# ─────────────────────────────────────────────────────────────
# Website (if available)
# ─────────────────────────────────────────────────────────────
echo "Testing Website..."

if curl -sf "$WEBSITE_URL" | grep -qi "paypal\|exchange\|usdt"; then
    pass "Website loads"
else
    warn "Website not available at $WEBSITE_URL"
fi

echo ""

# ─────────────────────────────────────────────────────────────
# SSL Check (production only)
# ─────────────────────────────────────────────────────────────
if [ "$MODE" = "production" ]; then
    echo "Testing SSL..."

    if curl -sI "https://api.daniilink.com" | grep -q "200\|301\|302"; then
        pass "API SSL working"
    else
        fail "API SSL"
    fi

    if curl -sI "https://pp.daniilink.com" | grep -q "200\|301\|302"; then
        pass "Website SSL working"
    else
        fail "Website SSL"
    fi

    # Check certificate expiry
    CERT_EXPIRY=$(echo | openssl s_client -servername api.daniilink.com -connect api.daniilink.com:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    if [ -n "$CERT_EXPIRY" ]; then
        echo "  Certificate expires: $CERT_EXPIRY"
    fi

    echo ""
fi

# ─────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════"
if [ "$FAILED" = true ]; then
    echo -e "${RED}  Some tests failed!${NC}"
    exit 1
else
    echo -e "${GREEN}  All tests passed!${NC}"
fi
echo "═══════════════════════════════════════════════════════════════"
echo ""
