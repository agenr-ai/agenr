#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Deploying landing page to Cloudflare Pages..."
bunx wrangler pages deploy site --project-name agenr-site --commit-dirty=true

echo ""
echo "==> Landing page deploy complete!"
echo "    Site: https://agenr.ai"
