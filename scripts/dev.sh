#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[dev]${NC} $*"; }
ok()    { echo -e "${GREEN}[dev]${NC} $*"; }
warn()  { echo -e "${YELLOW}[dev]${NC} $*"; }
fail()  { echo -e "${RED}[dev]${NC} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------
command -v bun >/dev/null 2>&1 || fail "bun not found. Install: https://bun.sh"

# Kill any leftover dev processes from a previous run
info "Cleaning up stale processes..."
pkill -f "bun.*src/index.ts" 2>/dev/null || true
pkill -f "node.*vite" 2>/dev/null || true
sleep 1

# Fresh start: wipe local DB + generated artifacts so each run is clean
info "Resetting local database..."
rm -f data/agenr.db data/agenr.db-wal data/agenr.db-shm
rm -f data/adapters/*.hot-*.ts
rm -f data/.dev-api-key

if [ ! -d node_modules ]; then
  info "Installing dependencies..."
  bun install
fi

# Ensure .env exists
if [ ! -f .env ]; then
  info "Creating .env from .env.example..."
  cp .env.example .env
  # Set sensible local defaults
  cat >> .env <<'EOF'

# --- Added by dev script ---
AGENR_API_KEY=dev-admin-key
AGENR_EXECUTE_POLICY=confirm
AGENR_ALLOW_HTTP=1
EOF
  ok ".env created with local dev defaults"
fi

# Source .env to read PORT
set -a
source .env
set +a
PORT="${PORT:-3001}"

# ---------------------------------------------------------------------------
# Cleanup on exit
# ---------------------------------------------------------------------------
PIDS=()
cleanup() {
  echo ""
  info "Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null
  done
  ok "Done."
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Start API server (without --watch to avoid hot-load restart loop)
# ---------------------------------------------------------------------------
info "Starting API server on port $PORT..."
mkdir -p data
bun src/index.ts &>/tmp/agenr-dev-server.log &
PIDS+=($!)

# Wait for server to be ready
for i in $(seq 1 20); do
  if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
  fail "Server failed to start. Check /tmp/agenr-dev-server.log"
fi
ok "API server ready at http://localhost:$PORT"

# ---------------------------------------------------------------------------
# Ensure a dev API key exists
# ---------------------------------------------------------------------------
DEV_KEY_FILE="data/.dev-api-key"
ADMIN_KEY="${AGENR_API_KEY:-dev-admin-key}"

if [ -f "$DEV_KEY_FILE" ]; then
  DEV_KEY=$(cat "$DEV_KEY_FILE")
  # Verify it still works
  if curl -sf -H "Authorization: Bearer $DEV_KEY" "http://localhost:$PORT/keys/me" >/dev/null 2>&1; then
    ok "Dev API key loaded from $DEV_KEY_FILE"
  else
    warn "Stored dev key is stale, creating new one..."
    rm -f "$DEV_KEY_FILE"
    DEV_KEY=""
  fi
fi

if [ ! -f "$DEV_KEY_FILE" ]; then
  info "Creating dev API key..."
  RESPONSE=$(curl -sf -X POST \
    -H "Authorization: Bearer $ADMIN_KEY" \
    -H "Content-Type: application/json" \
    -d '{"label":"local-dev","tier":"paid"}' \
    "http://localhost:$PORT/keys" 2>&1) || fail "Failed to create API key. Is AGENR_API_KEY set in .env?"
  
  DEV_KEY=$(echo "$RESPONSE" | bun -e "const j=JSON.parse(await Bun.stdin.text()); console.log(j.key)")
  echo "$DEV_KEY" > "$DEV_KEY_FILE"
  ok "Dev API key created and saved to $DEV_KEY_FILE"
fi

# ---------------------------------------------------------------------------
# Start console dev server
# ---------------------------------------------------------------------------
info "Starting console on port 5173..."
cd console
VITE_API_URL="http://localhost:$PORT" bun run dev &>/tmp/agenr-dev-console.log &
PIDS+=($!)
cd "$ROOT"

# Wait for console
for i in $(seq 1 20); do
  if curl -sf "http://localhost:5173" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -sf "http://localhost:5173" >/dev/null 2>&1; then
  fail "Console failed to start. Check /tmp/agenr-dev-console.log"
fi
ok "Console ready at http://localhost:5173"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Agenr Local Dev Environment${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "  API:     ${CYAN}http://localhost:$PORT${NC}"
echo -e "  Console: ${CYAN}http://localhost:5173${NC}"
echo -e "  API Key: ${YELLOW}$DEV_KEY${NC}"
echo -e ""
echo -e "  Paste the API key into the console login."
echo -e "  Press ${RED}Ctrl+C${NC} to stop everything."
echo -e "${GREEN}========================================${NC}"
echo ""

# Keep alive
wait
