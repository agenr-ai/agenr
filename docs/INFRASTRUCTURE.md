# Infrastructure

## Architecture Overview

Agenr's production infrastructure uses three managed services:

| Component | Provider | Purpose |
|-----------|----------|---------|
| **Landing page** | Cloudflare Pages | Static marketing site |
| **API server** | Fly.io | Bun-based API, OAuth flows, adapter execution |
| **Database** | Turso (libSQL) | SQLite-compatible cloud database with edge replicas |
| **DNS** | Cloudflare | DNS and CDN proxy |

## Why These Choices

### Cloudflare Pages (Landing Page)
- Free global CDN with push-to-deploy from the repo
- Static site — zero maintenance, zero cost

### Fly.io (API Server)
- Runs Bun natively in containers with no code changes from local dev
- `@libsql/client` connects to Turso over HTTP out of the box
- Filesystem access works (required for dynamic adapter loading)
- No CPU time limits — important for OAuth flows and long-running requests
- Auto-scaling from 1 to 20+ machines across regions

### Turso (Database)
- SQLite-compatible — same SQL dialect in dev and production
- Edge read replicas co-locate with Fly regions for low latency
- Read-heavy workload (`discover`/`query`) is ideal for this architecture
- Generous free tier that scales to production traffic

### Why Not Cloudflare Workers?
Workers were evaluated and rejected:
- `@libsql/client` requires a different web transport import path
- No filesystem access (breaks dynamic adapter loading)
- CPU time limits (50 ms free / 30 s paid) are too restrictive
- Would require significant refactoring for no benefit

## Environment Variables

**Required:**

| Variable | Description |
|----------|-------------|
| `AGENR_DB_URL` | Turso database URL |
| `AGENR_DB_AUTH_TOKEN` | Turso auth token |
| `AGENR_API_KEY` | Admin API key for management endpoints |
| `AGENR_EXECUTE_POLICY` | `confirm` or `strict` (never `open` in production) |
| `AGENR_CORS_ORIGINS` | Comma-separated list of allowed origins |

**OAuth:**

- `SQUARE_ENVIRONMENT` — `production` or `sandbox` (controls host selection; not a secret)
- OAuth app credentials are stored in the encrypted vault via the admin API or CLI (`agenr config set oauth ...`), **not** as environment variables.

## Deployment

### Initial Setup

```bash
# Create Fly app
fly launch --region <region> --no-deploy

# Set secrets
fly secrets set \
  AGENR_DB_URL=<turso-url> \
  AGENR_DB_AUTH_TOKEN=<token> \
  AGENR_API_KEY=<key>

# Deploy
fly deploy
```

### Scaling

```bash
fly scale count <n> --region <regions>
fly scale vm shared-cpu-2x --memory 1024
```

### Monitoring

```bash
fly logs
fly status
```

## DNS Configuration

- **Root domain** → Cloudflare Pages (configured automatically)
- **API subdomain** → CNAME to the Fly.io app, proxied through Cloudflare

## Database Setup

```bash
# Create database
turso db create <db-name>

# Get connection URL and token
turso db show <db-name> --url
turso db tokens create <db-name>

# Add edge replicas near your Fly regions
turso db replicate <db-name> <region>
```
