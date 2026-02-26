#!/bin/bash
set -euo pipefail
# Creates a clean OpenClaw test instance that mimics a normal user setup.
# OPENCLAW_HOME=~/.openclaw-testenv
# Config at ~/.openclaw-testenv/.openclaw/openclaw.json (OpenClaw's standard layout)
# Sessions at ~/.openclaw-testenv/.openclaw/agents/main/sessions
# Usage: ./setup-test-openclaw.sh [start|clean]

TEST_HOME="$HOME/.openclaw-testenv"
PORT=18791
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

case "${1:-start}" in
  start)
    if [ -d "$TEST_HOME" ]; then
      echo "Test instance already exists at $TEST_HOME"
      echo "Run: $0 clean   to remove it first"
      exit 1
    fi

    mkdir -p "$TEST_HOME/.openclaw/agents/main/sessions"
    cat > "$TEST_HOME/.openclaw/openclaw.json" << EOF
{
  "gateway": {
    "port": $PORT,
    "mode": "local",
    "bind": "loopback",
    "controlUi": {
      "enabled": true,
      "dangerouslyDisableDeviceAuth": true
    },
    "auth": {
      "mode": "token",
      "token": "$(openssl rand -hex 24)"
    }
  }
}
EOF

    echo "Created test OpenClaw instance at $TEST_HOME"
    echo ""
    echo "Terminal 1 - Start gateway:"
    echo "  OPENCLAW_HOME=$TEST_HOME openclaw gateway"
    echo ""
    echo "Terminal 2 - Run wizard:"
    echo "  cd $REPO_ROOT && node dist/cli.js init"
    echo ""
    echo "When the wizard asks for OpenClaw directory, enter:"
    echo "  $TEST_HOME"
    echo ""
    echo "Clean up when done:"
    echo "  $0 clean"
    ;;

  clean)
    if [ ! -d "$TEST_HOME" ]; then
      echo "No test instance found at $TEST_HOME"
      exit 0
    fi

    PID=$(lsof -ti :$PORT 2>/dev/null || true)
    if [ -n "$PID" ]; then
      echo "Stopping gateway (PID $PID)..."
      kill "$PID" 2>/dev/null
      sleep 1
    fi

    rm -rf "$TEST_HOME"
    echo "Cleaned up $TEST_HOME"
    ;;

  *)
    echo "Usage: $0 [start|clean]"
    exit 1
    ;;
esac
