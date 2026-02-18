#!/usr/bin/env bash
# Sandbox environment for agenr development.
# Creates an isolated config + DB so you can test without touching your live data.
#
# Usage:
#   bash scripts/sandbox-setup.sh
#   source sandbox/env.sh
#   sandbox-agenr db stats
#
# Reset:
#   sandbox-reset

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX_ROOT="$REPO_ROOT/sandbox"
DATA_DIR="$SANDBOX_ROOT/data"
AGENR_SANDBOX_DIR="$DATA_DIR/agenr"

echo "=== Setting up agenr sandbox ==="

mkdir -p "$AGENR_SANDBOX_DIR"

# Create sandbox config
if [ ! -f "$AGENR_SANDBOX_DIR/config.json" ]; then
  LIVE_CONFIG="$HOME/.agenr/config.json"
  if [ -f "$LIVE_CONFIG" ]; then
    # Copy auth from live config, redirect DB to sandbox
    node -e "
      const live = JSON.parse(require(fs).readFileSync(, utf8));
      live.db = { path: /knowledge.db };
      console.log(JSON.stringify(live, null, 2));
    " > "$AGENR_SANDBOX_DIR/config.json"
    echo "  Copied auth from $LIVE_CONFIG"
  else
    # No live config - create minimal sandbox config
    cat > "$AGENR_SANDBOX_DIR/config.json" << EOF
{
  "db": { "path": "$AGENR_SANDBOX_DIR/knowledge.db" }
}
EOF
    echo "  Created minimal config (no auth - run agenr auth to configure)"
  fi
  chmod 600 "$AGENR_SANDBOX_DIR/config.json"
  echo "  Config: $AGENR_SANDBOX_DIR/config.json"
  echo "  DB:     $AGENR_SANDBOX_DIR/knowledge.db"
else
  echo "  Sandbox config already exists"
fi

# Generate env.sh
cat > "$SANDBOX_ROOT/env.sh" << ENVEOF
# Source this to load sandbox commands: source sandbox/env.sh

_SANDBOX_REPO_ROOT="$REPO_ROOT"
_SANDBOX_CONFIG="$AGENR_SANDBOX_DIR/config.json"

sandbox-agenr() {
  AGENR_CONFIG_PATH="\$_SANDBOX_CONFIG" node "\$_SANDBOX_REPO_ROOT/dist/cli.js" "\$@"
}

sandbox-reset() {
  echo "Nuking sandbox data..."
  rm -rf "$SANDBOX_ROOT/data"
  bash "$REPO_ROOT/scripts/sandbox-setup.sh"
  source "$SANDBOX_ROOT/env.sh"
  echo "Done."
}

echo "Sandbox loaded. Commands: sandbox-agenr, sandbox-reset"
echo "  DB: $AGENR_SANDBOX_DIR/knowledge.db"
ENVEOF

echo ""
echo "=== Done ==="
echo ""
echo "  source sandbox/env.sh"
echo "  sandbox-agenr db stats"
