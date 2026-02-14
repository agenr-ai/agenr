# Agenr

Context-efficient gateway for agent-to-world interaction. Replaces heavy MCP servers with lean adapters using progressive disclosure.

## Current Direction

Agenr is pivoting from agent commerce to solving **MCP context bloat** — the #1 pain point in the AI agent ecosystem. MCP servers dump 50K+ tokens of tool schemas into agent context before the agent says hello. Agenr reduces this to ~500 tokens via progressive disclosure.

**What stays the same:**
- The core pattern: **discover → query → execute** (progressive disclosure)
- Adapter runtime, confirmation flows, credential management

**What changed:**
- Adapters call REST APIs directly via `fetch()` — no background MCP daemon needed
- Agenr **replaces** MCP servers rather than just proxying them
- Target user: agent developers (not business owners)

See `docs/pivot/README.md` for the full strategic analysis.

## Prerequisites

- **Node.js >= 20** (required)
- **pnpm** (preferred) or npm/yarn
- **Bun** (optional — works but not required)

## Stack

- **Runtime:** Node.js (Bun optional)
- **Framework:** Hono (REST API)
- **Language:** TypeScript (strict)
- **Validation:** Zod
- **LLM:** `@mariozechner/pi-ai` + `@mariozechner/pi-agent-core` (OAuth + API key support for Codex Pro & Anthropic Max, plus agentic tool loops)

## Project Structure

```
src/
  index.ts                  # Hono API server (AGP + auth + adapter management routes)
  cli.ts                    # CLI entry point (generate, test, demo-reset, config)
  core/agp-service.ts       # Orchestrates discover/query/execute with transaction tracking
  connections/
    base-url.ts             # Canonical public base URL resolver for OAuth callbacks
    oauth-state.ts          # DB-backed OAuth state creation/validation/cleanup
  db/
    client.ts               # libSQL client singleton (local SQLite or Turso URL)
    adapters.ts             # Adapter metadata CRUD (sandbox/review/public/rejected/archived)
    users.ts                # Social-auth user CRUD (provider identity mapping)
    sessions.ts             # Session CRUD/validation/touch/cleanup
    seed-echo.ts            # Startup seed for the public demo Echo business
    seed-demo-key.ts        # Startup seed for public demo API key (`ak_test_public_demo`)
    migrate.ts              # Startup CREATE TABLE migrations
    index.ts                # DB exports
  vault/
    types.ts                # Vault credential and ciphertext data types
    kms.ts                  # AWS KMS wrapper with local mock mode
    encryption.ts           # AES-256-GCM + zero-fill memory hygiene helpers
    credential-store.ts     # Credential vault CRUD (envelope encryption + DB)
    audit.ts                # Credential audit logging writer helpers
    audit-queries.ts        # Guarded read-only credential audit query helpers
    audit-verification.ts   # Audit hash-chain verification helpers
    app-credential-store.ts # Vault CRUD for app-level OAuth client credentials
    token-refresh.ts        # OAuth token refresh helper for near-expiry credentials
    index.ts                # Vault barrel exports
  middleware/
    auth.ts                 # Optional API key auth for protected routes
    request-id.ts           # Request ID injection/preservation middleware (`X-Request-Id`)
    logger.ts               # Structured HTTP request logging middleware
    policy.ts               # Execute confirmation/strict policy enforcement
    idempotency.ts          # Execute idempotency replay cache
  routes/
    auth.ts                 # Social login/session routes (`/auth/*`)
    adapters.ts             # Runtime adapter lifecycle routes (list/generate/upload/submit/review/promote/demote/archive/hard-delete)
    connect.ts              # OAuth connection routes (`/connect/services`, `/connect/:service`)
    credentials.ts          # Credential CRUD routes (`/credentials`)
    app-credentials.ts      # Admin OAuth app credential routes (`/app-credentials`)
    audit.ts                # Role-scoped audit verification route (`/audit/verify`)
  jobs/
    generation-queue.ts     # Persistent generation job queue CRUD + claim/log lifecycle
    generation-worker.ts    # In-process background worker for queued generation jobs
  adapters/
    adapter.ts              # AgpAdapter interface (discover/query/execute contract)
  utils/
    adapter-paths.ts        # Runtime adapter path resolution (public/sandbox/rejected)
    logger.ts               # Structured JSON logger utility for runtime logs
    url-validation.ts       # HTTPS/localhost adapter URL validation helper
  profiles/meal-selection-engine.ts # Heuristic meal selection engine
  cli/
    adapter-test.ts         # Adapter smoke test runner (discover/query/execute)
    demo-reset.ts           # Staging/demo DB reset utility for seeded demo users
    generator.ts            # AI adapter generation engine
    discovery-agent.ts      # Agentic doc discovery loop (pi-agent-core tools)
    discovery-cache.ts      # Discovery cache read/write + freshness helpers
    discovery-types.ts      # Discovery findings/result interfaces
    openapi.ts              # OpenAPI probing + parsing helpers
    pi-ai-client.ts         # Thin wrapper around pi-ai complete()/stream()
    credentials.ts          # Credential resolution (OAuth, Keychain, API keys)
    config-store.ts         # CLI config persistence
    documents.ts            # Doc fetching for adapter generation
    llm-client.ts           # LLM runtime resolution
    web-search.ts           # Web search for doc discovery
  scripts/
    seed-activity.ts        # Seed credential audit activity for console demos
  types/                    # AGP protocol + profile types
  store/                    # Profile, interaction profile, and transaction stores
data/
  adapters/                 # Bundled + runtime-loaded adapters (public seeded on startup + owner-scoped sandbox/review)
  agenr.db                  # Local SQLite DB (auto-created, GITIGNORED)
  user-profile.json         # User config with auth tokens (GITIGNORED)
  user-profile.example.json # Template without secrets
  discovery-cache/          # Cached discovery findings for generate retries
  interaction-profiles/     # Platform capability definitions (JSON)
docs/
  AGP-SPEC.md              # AGP protocol spec (with OAuth section)
  AI-ADAPTER-GENERATION.md  # How agenr generate works (implemented & proven)
  DISCOVERY-TOOLS-V2.md     # Planned v2 discovery tools
  TODO.md                  # Running task list — KEEP THIS UPDATED
packages/
  sdk/
    src/                   # Standalone TypeScript SDK client (`@agenr/sdk`)
    package.json           # npm package metadata/scripts
    README.md              # Public SDK docs + quick start
    LICENSE                # MIT license (SDK package)
  mcp/
    src/                   # MCP server package exposing AGP as MCP tools (`@agenr/mcp`)
    package.json           # npm package metadata/scripts
    README.md              # MCP install/config docs
    LICENSE                # MIT license (MCP package)
  openclaw-skill/
    SKILL.md               # OpenClaw skill instructions + MCP runtime config for `@agenr/mcp`
    README.md              # Public OpenClaw skill usage docs
    package.json           # npm package metadata for `@agenr/openclaw-skill`
```

## Agent Context Files

`CLAUDE.md` is a symlink to this file (`AGENTS.md`). One source of truth — Claude Code reads `CLAUDE.md`, Codex reads `AGENTS.md`, both get the same context. Edit `AGENTS.md` only.

## Commands

```bash
# Server
pnpm run dev              # Start dev server (hot reload)
pnpm run start            # Start server
pnpm run typecheck        # TypeScript type checking
pnpm run test             # Run all tests
pnpm run test:mcp         # Run MCP tool wiring tests
pnpm run test:db          # Run DB integration tests
pnpm run build:mcp        # Build MCP server package
pnpm run seed:activity -- [--user-id <id> --service <name> --count <n>] # Seed credential activity demo data

# CLI
agenr generate <business> [--docs-url <url>] [--verbose] [--quiet|--no-thinking] [--skip-discovery] [--rediscover]  # AI-generate an adapter
agenr test --list                                           # List configured testable adapters
agenr test <platform> [--verbose] [--include-execute]       # Smoke-test discover/query/execute against adapter APIs
agenr demo-reset [--db-url <url>] [--db-token <token>] [--confirm]  # Reset demo users in a staging/prod Turso DB
agenr config show                                          # Show current LLM config
agenr config set provider <openai-api|codex|claude-code|anthropic-api>
agenr config set model <model|default>
agenr config set subscription-token <token>
agenr config set api-key <openai|anthropic> <key>
agenr config set oauth <service> <client-id> <client-secret>
agenr config remove oauth <service>
agenr config show oauth

# Env vars (optional)
AGENR_API_KEY=<admin-backdoor-api-key>
AGENR_CORS_ORIGINS=<comma-separated-origins>
AGENR_EXECUTE_POLICY=<open|confirm|strict>
AGENR_MAX_EXECUTE_AMOUNT=<cents-cap-for-strict-policy>
AGENR_ADAPTER_TIMEOUT_MS=<adapter-operation-timeout-ms; default 30000>
AGENR_ALLOW_HTTP=<1-to-allow-http-adapter-urls-in-local-dev>
AGENR_BASE_URL=<public-api-url-for-oauth-callbacks; defaults to http://localhost:PORT>
AGENR_ADAPTERS_DIR=<optional-path-to-dynamic-adapter-directory>
AGENR_BUNDLED_ADAPTERS_DIR=<optional-path-to-bundled-adapter-directory; default data/adapters>
AGENR_DB_URL=<optional-libsql-url-for-remote-turso-db>
AGENR_DB_AUTH_TOKEN=<optional-auth-token-for-remote-libsql-db>
AGENR_KMS_KEY_ID=<optional-aws-kms-key-id; unset enables local mock-kms>
AWS_REGION=<aws-region-for-kms>
AWS_ACCESS_KEY_ID=<aws-access-key-id-for-kms>
AWS_SECRET_ACCESS_KEY=<aws-secret-access-key-for-kms>
AGENR_ADAPTER_SYNC_INTERVAL_MS=<periodic-db-to-disk-adapter-sync-ms; default 300000; 0 disables>
AGENR_GENERATION_DAILY_LIMIT=<max-generation-jobs-per-source-per-24h>
AGENR_JOB_POLL_INTERVAL_MS=<generation-worker-poll-interval-ms>
AGENR_LLM_SUBSCRIPTION_TOKEN=<claude-setup-token>
AGENR_LLM_OPENAI_API_KEY=<openai-api-key>
AGENR_LLM_ANTHROPIC_API_KEY=<anthropic-api-key>
SQUARE_ENVIRONMENT=<production|sandbox>
CONSOLE_ORIGIN=<console-origin-for-auth-redirects>
GOOGLE_CLIENT_ID=<google-oauth-client-id-bootstrap-only>
GOOGLE_CLIENT_SECRET=<google-oauth-client-secret-bootstrap-only>
GITHUB_CLIENT_ID=<github-oauth-client-id-bootstrap-only>
GITHUB_CLIENT_SECRET=<github-oauth-client-secret-bootstrap-only>
```

## Testing

Tests live in `tests/` and use Vitest.

```bash
pnpm run test                           # Run all tests
pnpm exec vitest run tests/<file>.ts   # Run specific test file
```

Test conventions:
- DB tests use `:memory:` SQLite -- never touch the dev database
- Name test files `<feature>.test.ts`
- Every new feature that touches persistence or middleware should have integration tests
- Run `pnpm run test` before committing to verify nothing broke

Existing tests:
- `tests/test-security.sh` -- curl-based security hardening validation (run manually with server up)
- `tests/db-integration.test.ts` -- DB layer integration tests (token store, transactions, idempotency, confirmation tokens)
- `tests/vault/encryption.test.ts` -- AES-256-GCM, tamper detection, and zero-fill behavior
- `tests/vault/kms.test.ts` -- KMS local mock data-key generation/decryption coverage
- `tests/vault/credential-store.test.ts` -- encrypted credential storage/retrieval/list/delete integration tests
- `tests/echo-adapter.test.ts` -- bundled Echo adapter discover/query/execute behavior
- `tests/seed-demo-key.test.ts` -- public demo API key seeding/auth/scope coverage
- `tests/mcp-tools.test.ts` -- MCP tool registration/wiring and SDK error-to-MCP-content behavior

`agenr generate` discovery cache behavior:
- Saves findings to `data/discovery-cache/<platform>.json` after successful discovery.
- `--skip-discovery` reuses cache and fails if cache is missing/invalid.
- `--rediscover` forces fresh discovery and overwrites cache.
- On successful generation, auto-appends a `businesses[]` entry to `data/user-profile.json` when that platform is not already present, and prints the added entry.

`agenr test` behavior:
- Uses the runtime adapter registry (public + owner-scoped adapters from `data/adapters/` or `AGENR_ADAPTERS_DIR`) and matches configured businesses in `data/user-profile.json`.
- Dynamic adapter source is persisted in DB (`adapters.source_code`/`source_hash`) and restored before startup hot-loading.
- Bundled adapters from `data/adapters/` (or `AGENR_BUNDLED_ADAPTERS_DIR`) are seeded/updated on startup before dynamic hot-loading. Public adapters only update when bundled semver is newer.
- Runs `discover` then `query`; validates result shape and continues after failures.
- `execute` is skipped by default. Use `--include-execute` to opt in; Stripe execute runs only when discover reports test mode.

## API

```
GET  /health                # Health check (no auth required)
POST /agp/discover      # Business metadata + capabilities
POST /agp/query         # Fetch data, auto-pick options
POST /agp/execute/prepare # Generate confirmation token for execute
POST /agp/execute       # Perform action (save selections, book, etc.)
GET  /agp/status/:id    # Transaction status
GET  /adapters          # List loaded adapters
POST /adapters/generate # Queue adapter generation job (async)
POST /adapters/:platform/upload # Upload adapter source into caller sandbox
POST /adapters/:platform/submit # Submit sandbox adapter for admin review
POST /adapters/:platform/withdraw # Withdraw caller review adapter back to sandbox
GET  /adapters/reviews  # List pending review adapters (admin)
GET  /adapters/archived # List archived adapters (admin)
POST /adapters/:platform/reject # Reject review adapter with feedback (admin)
GET  /adapters/jobs     # List generation jobs (summary)
GET  /adapters/jobs/:id # Fetch generation job status/logs/result
DELETE /adapters/:platform # Remove caller sandbox adapter (admin archives instead of hard-delete)
DELETE /adapters/:platform/hard # Permanently delete adapter row/file (admin)
POST /adapters/:platform/promote # Promote sandbox/review adapter to public (admin)
POST /adapters/:platform/demote # Demote public adapter to sandbox (admin)
GET  /connect/services  # List OAuth-capable services with configured app credentials
GET  /connect/:service  # Start OAuth connection for a supported service
GET  /connect/:service/callback # OAuth callback handler (state validation + token exchange)
GET  /auth/google       # Start Google social login
GET  /auth/google/callback # Google callback (session + cookie)
GET  /auth/github       # Start GitHub social login
GET  /auth/github/callback # GitHub callback (session + cookie)
GET  /auth/me           # Current signed-in session user (includes isAdmin)
POST /auth/logout       # End session + clear cookie
GET  /credentials       # List connected services (status only, no secrets)
GET  /credentials/:service/activity # List paginated credential audit activity for a service
POST /credentials/:service # Store manual credentials (api_key/cookie/basic)
DELETE /credentials/:service # Disconnect a service credential
GET  /audit/verify        # Verify audit integrity (admins: full chain; users: own entries)
GET  /businesses/:id/activity # List paginated AGP-relevant owner activity for dashboard recent activity
GET  /businesses/:id/connections # List all owner credential connections for a business (admin only)
DELETE /businesses/:id/connections/:service # Revoke one owner credential connection for a business (admin only)
GET  /app-credentials  # List configured OAuth app credentials (admin only)
POST /app-credentials/:service # Store/update OAuth app credential (admin only)
DELETE /app-credentials/:service # Remove OAuth app credential (admin only)
POST /keys              # Create API key (signed-in session or admin key)
GET  /keys/me           # Current API key metadata
GET  /keys              # List API keys (admin only)
DELETE /keys/:id        # Revoke API key (admin only)
POST /keys/:id/link     # Link existing API key to a user (admin only)
```

OAuth app credentials (for example, Stripe/Square client ID + secret) are stored in the vault under a reserved system identity, not environment variables.

## Deployment

See `docs/INFRASTRUCTURE.md` for full details.

```bash
fly deploy --config fly.staging.toml     # Deploy staging
fly deploy                          # Deploy to Fly.io
fly logs                            # Tail production logs
fly status                          # Check app status
fly secrets set KEY=value           # Set env vars
```

## Key Rules

- **Never commit `data/user-profile.json`** — contains auth tokens. It's gitignored.
- **Keep docs updated** — when you complete work, update `docs/TODO.md` (the single roadmap), this file, and `README.md`. Never add roadmap checkboxes to other docs.
- **No browser automation** — adapters use APIs, not scraping. It's OK for an adapter to not support all 3 ops.
- OpenAI-family reasoning models don't support `temperature`/`maxTokens` — pi-ai client strips them.
- Commit after each meaningful change.

## Adapter Development

Adapters are single `.ts` files in `data/adapters/`. Each adapter:

- Imports from `"agenr:adapter-api"`
- Implements the `AgpAdapter` interface: `discover`, `query`, `execute`
- Calls REST APIs directly via `fetch()` — no background daemon

**Auth:** Use `ctx.fetch()` for authenticated requests (handles credential injection automatically). For no-auth APIs (like Domino's), raw `fetch()` is fine.

**Reference adapters:**
- `echo.ts` — Test/demo adapter
- `dominos.ts` — No-auth real API (proves the pattern)
- `github.ts` — Authenticated API adapter (planned)

## Deeper Context

Read these when relevant:
- `docs/AGP-SPEC.md` — AGP protocol specification
- `docs/AI-ADAPTER-GENERATION.md` — How adapter generation works (proven with Toast + Stripe)
- `docs/DISCOVERY-TOOLS-V2.md` — Planned v2 discovery tools
- `docs/TODO.md` — **THE roadmap and task list** (single source of truth — no roadmap checkboxes in other docs)
- `data/interaction-profiles/` — Platform capability definitions (sample platform profiles)

## Active Pivot: Clean Breaks Are Fine

Agenr launched February 13, 2026 and is now in an active pivot (see Current Direction above). There are no external users or third-party integrations yet. Do NOT write backward-compatible code — no optional parameters for migration, no deprecated paths, no legacy fallbacks. If an interface changes, change it everywhere. Clean breaks only. This keeps the codebase tight during the transition.

## Git & PR Practices

This is a public open-source repo. Follow these conventions:

- **Never push directly to `master`** — always use a feature branch + PR.
- **Branch naming:** `<type>/<short-description>` (e.g. `feat/consumer-auth`, `fix/token-refresh`, `chore/node-first-runtime`)
- **Commit messages:** Follow [Conventional Commits](https://www.conventionalcommits.org/):
  - `feat:` new feature
  - `fix:` bug fix
  - `chore:` maintenance, refactoring, deps
  - `docs:` documentation only
  - `test:` adding/fixing tests
- **One logical change per PR** — don't bundle unrelated work.
- **PR description:** Explain what and why. Include test steps if non-obvious.
- **Tests pass before merge** — run `pnpm test && pnpm run typecheck` locally.
- **Squash merge preferred** — keeps master history clean.
- **Tag releases:** Use semver tags (`v0.2.0`) when shipping meaningful milestones.
- **Clean up after merge:** Switch to master, pull, delete the local and remote branch.
