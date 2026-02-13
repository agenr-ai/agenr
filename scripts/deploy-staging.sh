#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Running tests..."
bun test

echo ""
echo "==> Deploying API to staging (Fly)..."
fly deploy --config fly.staging.toml

echo ""
echo "==> Building console for staging..."
VITE_API_URL=https://agenr-api-staging.fly.dev bun run --cwd console build

echo ""
echo "==> Deploying console to staging (Cloudflare Pages)..."
bunx wrangler pages deploy console/dist --project-name agenr-console --branch staging --commit-dirty=true

echo ""
echo "==> Staging deploy complete!"
echo "    API:     https://agenr-api-staging.fly.dev"
echo "    Console: https://staging.agenr-console.pages.dev"
