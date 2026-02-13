#!/bin/bash
# Store OAuth app credentials (GitHub, Google, Stripe, Square) in Agenr vault
# Usage: ./setup-oauth-creds.sh <environment>
#   environment: local | staging | production

set -e

ENV="${1:-local}"

case "$ENV" in
  local)
    URL="http://localhost:3001"
    echo "Enter local admin API key:"
    read -r API_KEY
    ;;
  staging)
    URL="https://agenr-api-staging.fly.dev"
    echo "Enter staging admin API key:"
    read -r API_KEY
    ;;
  production|prod)
    URL="https://api.agenr.ai"
    echo "Enter production admin API key:"
    read -r API_KEY
    ;;
  *)
    echo "Usage: $0 <local|staging|production>"
    exit 1
    ;;
esac

store_cred() {
  local service="$1"
  local client_id="$2"
  local client_secret="$3"

  echo "  Storing $service..."
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"clientId\":\"$client_id\",\"clientSecret\":\"$client_secret\"}" \
    "$URL/app-credentials/$service")

  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    echo "  ✓ $service stored"
  else
    echo "  ✗ $service failed (HTTP $HTTP_CODE)"
  fi
}

echo ""
echo "=== Setting up OAuth app credentials for $ENV ==="
echo "    API: $URL"
echo ""

# GitHub
echo "--- GitHub OAuth App ---"
echo "  Client ID:"
read -r GITHUB_ID
echo "  Client Secret:"
read -rs GITHUB_SECRET
echo ""
store_cred "github" "$GITHUB_ID" "$GITHUB_SECRET"

# Google
echo ""
echo "--- Google OAuth App ---"
echo "  Client ID:"
read -r GOOGLE_ID
echo "  Client Secret:"
read -rs GOOGLE_SECRET
echo ""
store_cred "google" "$GOOGLE_ID" "$GOOGLE_SECRET"

# Google Auth (console social login)
echo ""
echo "--- Google Auth (console login) ---"
echo "  Same as above? (y/n)"
read -r SAME_GOOGLE
if [ "$SAME_GOOGLE" = "y" ]; then
  store_cred "google_auth" "$GOOGLE_ID" "$GOOGLE_SECRET"
else
  echo "  Client ID:"
  read -r GOOGLE_AUTH_ID
  echo "  Client Secret:"
  read -rs GOOGLE_AUTH_SECRET
  echo ""
  store_cred "google_auth" "$GOOGLE_AUTH_ID" "$GOOGLE_AUTH_SECRET"
fi

# GitHub Auth (console social login)
echo ""
echo "--- GitHub Auth (console login) ---"
echo "  Same as GitHub above? (y/n)"
read -r SAME_GITHUB
if [ "$SAME_GITHUB" = "y" ]; then
  store_cred "github_auth" "$GITHUB_ID" "$GITHUB_SECRET"
else
  echo "  Client ID:"
  read -r GITHUB_AUTH_ID
  echo "  Client Secret:"
  read -rs GITHUB_AUTH_SECRET
  echo ""
  store_cred "github_auth" "$GITHUB_AUTH_ID" "$GITHUB_AUTH_SECRET"
fi

# Stripe
echo ""
echo "--- Stripe OAuth App (skip with Enter) ---"
echo "  Client ID:"
read -r STRIPE_ID
if [ -n "$STRIPE_ID" ]; then
  echo "  Client Secret:"
  read -rs STRIPE_SECRET
  echo ""
  store_cred "stripe" "$STRIPE_ID" "$STRIPE_SECRET"
else
  echo "  Skipped"
fi

# Square
echo ""
echo "--- Square OAuth App (skip with Enter) ---"
echo "  Client ID:"
read -r SQUARE_ID
if [ -n "$SQUARE_ID" ]; then
  echo "  Client Secret:"
  read -rs SQUARE_SECRET
  echo ""
  store_cred "square" "$SQUARE_ID" "$SQUARE_SECRET"
else
  echo "  Skipped"
fi

echo ""
echo "=== Done! ==="
echo ""
echo "Verify with:"
echo "  curl -s -H \"x-api-key: \$API_KEY\" $URL/app-credentials | python3 -m json.tool"
