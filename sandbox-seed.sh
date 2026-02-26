#!/usr/bin/env bash
# sandbox-seed.sh - Seed the agenr sandbox with test session data
#
# Copies fixture sessions from fixtures/seed-sessions/ into the sandbox.
# These sessions exercise extraction, claim extraction, contradiction
# detection, and the conflicts review UI.
#
# Usage: ./sandbox-seed.sh [--reset]
#   --reset  Clear existing sandbox data before seeding

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/fixtures/seed-sessions"
SANDBOX_HOME="$HOME/.openclaw-sandbox"
SESSIONS_DIR="$SANDBOX_HOME/.openclaw/agents/main/sessions"
AGENR_DATA="$SANDBOX_HOME/agenr-data"

if [[ ! -d "$FIXTURES_DIR" ]]; then
  echo "[seed] Error: fixtures/seed-sessions/ not found. Run from repo root."
  exit 1
fi

if [[ "${1:-}" == "--reset" ]]; then
  echo "[seed] Resetting sandbox data..."
  rm -f "$SESSIONS_DIR"/*.jsonl
  rm -f "$AGENR_DATA"/knowledge.db*
  echo "[seed] Clean slate."
fi

mkdir -p "$SESSIONS_DIR"
mkdir -p "$AGENR_DATA"

count=0
for f in "$FIXTURES_DIR"/seed-*.jsonl; do
  cp "$f" "$SESSIONS_DIR/"
  echo "[seed] Copied $(basename "$f")"
  count=$((count + 1))
done

echo ""
echo "[seed] Copied $count test sessions to sandbox."
echo ""
echo "[seed] Contradiction scenarios:"
echo "  Session 1 -> 3: weight 185 -> 175, Tesla -> Rivian, keto -> Mediterranean"
echo "  Session 1 -> 4: TechCorp -> DataFlow, CockroachDB migration canceled"
echo "  Session 1 -> 4: favorite language Rust -> Go preference shift"
echo "  Session 5 -> 6: events, todos, relationships, edge cases"
echo ""
echo "[seed] Next steps:"
echo "  1. pnpm build"
echo "  2. node dist/cli.js ingest $SESSIONS_DIR --db $AGENR_DATA/knowledge.db"
echo "  3. node dist/cli.js conflicts --db $AGENR_DATA/knowledge.db"
