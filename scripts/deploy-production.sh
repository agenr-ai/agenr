#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "Error: Working tree is dirty. Commit or stash changes before deploying to production."
  exit 1
fi

echo "==> Running tests..."
bun test

echo ""
echo "==> Deploying API to production (Fly)..."
fly deploy

echo ""
echo "==> Building console for production..."
VITE_API_URL=https://api.agenr.ai bun run --cwd console build

echo ""
echo "==> Deploying console to production (Cloudflare Pages)..."
bunx wrangler pages deploy console/dist --project-name agenr-console

echo ""
echo "==> Production deploy complete!"
echo "    API:     https://api.agenr.ai"
echo "    Console: https://console.agenr.ai"
