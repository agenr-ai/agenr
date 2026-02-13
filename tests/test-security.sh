#!/bin/bash
set -e
BASE="http://localhost:3001"
KEY="test-key-123"

echo "========================================"
echo "Agenr Security Hardening Test Suite"
echo "========================================"
echo ""

# 1. Health check (no auth required)
echo "[1] Health check (no auth) — expect 200"
curl -s -o /dev/null -w "HTTP %{http_code}" $BASE/
echo ""
echo ""

# 2. AGP route WITHOUT auth — expect 401
echo "[2] /agp/discover WITHOUT API key — expect 401"
curl -s -w "\nHTTP %{http_code}" -X POST $BASE/agp/discover \
  -H "Content-Type: application/json" \
  -d '{"businessId":"factor"}'
echo ""
echo ""

# 3. AGP route WITH auth — expect 200 or business error
echo "[3] /agp/discover WITH API key — expect 200"
curl -s -w "\nHTTP %{http_code}" -X POST $BASE/agp/discover \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{"businessId":"factor"}'
echo ""
echo ""

# 4. X-API-Key header variant
echo "[4] /agp/discover with X-API-Key header — expect 200"
curl -s -w "\nHTTP %{http_code}" -X POST $BASE/agp/discover \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $KEY" \
  -d '{"businessId":"factor"}'
echo ""
echo ""

# 5. Execute WITHOUT confirmation (confirm mode) — expect 403
echo "[5] /agp/execute WITHOUT confirmation token — expect 403"
curl -s -w "\nHTTP %{http_code}" -X POST $BASE/agp/execute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{"businessId":"factor","request":{"week":"2026-W08"}}'
echo ""
echo ""

# 6. Prepare + execute flow
echo "[6a] /agp/execute/prepare — get confirmation token"
PREPARE=$(curl -s -X POST $BASE/agp/execute/prepare \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{"businessId":"factor","request":{"week":"2026-W08"}}')
echo "$PREPARE"
TOKEN=$(echo "$PREPARE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('confirmationToken',''))" 2>/dev/null || echo "")
echo ""

if [ -n "$TOKEN" ]; then
  echo "[6b] /agp/execute WITH confirmation token — expect 500 (token accepted, adapter fails without live creds)"
  curl -s -w "\nHTTP %{http_code}" -X POST $BASE/agp/execute \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $KEY" \
    -H "x-confirmation-token: $TOKEN" \
    -d '{"businessId":"factor","request":{"week":"2026-W08"}}'
  echo ""
  echo ""

  echo "[6c] Reuse same token — expect 403 (single-use)"
  curl -s -w "\nHTTP %{http_code}" -X POST $BASE/agp/execute \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $KEY" \
    -H "x-confirmation-token: $TOKEN" \
    -d '{"businessId":"factor","request":{"week":"2026-W08"}}'
  echo ""
else
  echo "[6b] SKIP — no token returned from prepare"
fi
echo ""

# 7. Idempotency
echo "[7] Idempotency — same key, same response"
PREPARE2=$(curl -s -X POST $BASE/agp/execute/prepare \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{"businessId":"factor","request":{"week":"2026-W08","mealIndexes":[0,1]}}')
TOKEN2=$(echo "$PREPARE2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('confirmationToken',''))" 2>/dev/null || echo "")
echo "First call (expect 500 — adapter fails, not cached):"
curl -s -w "\nHTTP %{http_code}" -X POST $BASE/agp/execute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -H "x-confirmation-token: $TOKEN2" \
  -H "Idempotency-Key: test-idemp-001" \
  -d '{"businessId":"factor","request":{"week":"2026-W08","mealIndexes":[0,1]}}'
echo ""
echo "Replay (same idemp key — expect 403, 500s are not cached):"
curl -s -w "\nHTTP %{http_code}" -X POST $BASE/agp/execute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: test-idemp-001" \
  -d '{"businessId":"factor","request":{"week":"2026-W08","mealIndexes":[0,1]}}'
echo ""
echo ""

# 8. Error sanitization — bad request should show generic error
echo "[8] Error sanitization — expect generic 500 with requestId"
curl -s -w "\nHTTP %{http_code}" -X POST $BASE/agp/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{"businessId":"nonexistent","request":{}}'
echo ""
echo ""

echo "========================================"
echo "Done!"
echo "========================================"
