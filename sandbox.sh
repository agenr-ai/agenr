#!/bin/bash
# Launch sandbox OpenClaw with local agenr plugin
export OPENCLAW_HOME=~/.openclaw-sandbox
export AGENR_DB_PATH=~/.openclaw-sandbox/agenr-data/knowledge.db
export PATH=/Users/jmartin/Library/pnpm:/opt/homebrew/bin:$PATH

case "${1:-start}" in
  start)   openclaw gateway start ;;
  stop)    openclaw gateway stop ;;
  restart) openclaw gateway restart ;;
  logs)    openclaw gateway logs ;;
  status)  openclaw gateway status ;;
  fg)      openclaw gateway run ;;
  *)       echo "Usage: ./sandbox.sh [start|stop|restart|logs|status|fg]" ;;
esac
