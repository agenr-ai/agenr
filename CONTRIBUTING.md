# Contributing to AGENR

Thanks for your interest in contributing to AGENR! This guide will help you get started.

## Quick Start

```bash
# Clone the repo
git clone https://github.com/agenr-ai/agenr.git
cd agenr

# Install dependencies (requires Bun >= 1.x)
bun install

# Copy environment template
cp .env.example .env

# Run the dev server
bun dev

# Run tests
bun test

# Typecheck
bun run typecheck
```

The server starts on `http://localhost:3001` by default.

## Project Structure

```
src/
  index.ts              # Server entry point (Hono)
  cli.ts                # CLI entry point
  core/
    agp-service.ts      # AGP protocol implementation
    adapter-registry.ts # Dynamic adapter loading + management
  adapters/
    context.ts          # AdapterContext — secure fetch with auth injection
  connections/          # OAuth providers + token refresh
  db/                   # Database layer (Turso/libSQL)
  middleware/           # Auth, CORS, rate limiting, idempotency
  routes/               # HTTP route handlers
  vault/                # Credential encryption (AES-256-GCM + KMS)
  jobs/                 # Async adapter generation queue
  store/                # Transaction + policy stores
  utils/                # Shared helpers

console/                # React SPA (Vite + Tailwind v4)
packages/sdk/           # @agenr/sdk — TypeScript client library
site/                   # Landing page (static HTML)
tests/                  # Test suites (bun:test)
docs/                   # Architecture docs, AGP spec, audit reports
```

## Adding an Adapter

Adapters are AI-generated via `agenr generate <platform>`, but you can also write them manually.

An adapter exports three things:

```typescript
import type { AdapterContext, AdapterManifest, AgpAdapter } from "agenr:adapter-api";

// 1. Manifest — declares auth requirements and allowed domains
export const manifest: AdapterManifest = {
  version: "2.0",
  auth: {
    strategy: "bearer",       // bearer | api-key-header | basic | cookie | custom | client-credentials | none
    required: true,
  },
  allowedDomains: ["api.example.com"],
};

// 2. Factory — creates an adapter instance
export default function createAdapter(business: any, ctx: AdapterContext): AgpAdapter {
  return {
    async discover() {
      // Return available capabilities
    },
    async query(params: Record<string, unknown>) {
      // Query business data
    },
    async execute(params: Record<string, unknown>) {
      // Execute a transaction
    },
  };
}
```

Key rules:
- Always use `ctx.fetch()` instead of global `fetch` — it handles auth injection and domain allowlisting
- Declare all domains your adapter calls in `allowedDomains`
- Choose the right auth strategy for the API you are integrating

## Running Tests

```bash
# All tests
bun test

# Specific test file
bun test tests/vault/encryption.test.ts

# Watch mode
bun test --watch
```

Tests use in-memory SQLite — no external services needed.

## Code Style

- **TypeScript** — strict mode, no `any` unless unavoidable
- **Formatting** — 2-space indent, double quotes, trailing commas
- **Imports** — use `type` imports for type-only imports
- **Errors** — use `internalServerError()` helper for 5xx responses; never expose internal details to clients
- **Logging** — use the structured logger (`src/utils/logger.ts`), not `console.log`
- **Dependencies** — prefer Bun built-ins over external packages

## Submitting Changes

1. Fork the repo and create a feature branch from `master`
2. Make your changes with clear, focused commits
3. Run `bun run typecheck && bun test` — everything must pass
4. Write clear commit messages (conventional commits preferred: `feat:`, `fix:`, `docs:`, `chore:`)
5. Open a PR against `master` with a description of what changed and why
6. Address review feedback promptly

PRs that touch security-sensitive code (vault, auth, middleware) will receive extra scrutiny — this is a feature, not a bug.

## Reporting Security Issues

See [SECURITY.md](SECURITY.md) for our responsible disclosure policy. **Do not** open public issues for security vulnerabilities.

## Getting Help

- **Issues**: [github.com/agenr-ai/agenr/issues](https://github.com/agenr-ai/agenr/issues)
- **Discussions**: [github.com/agenr-ai/agenr/discussions](https://github.com/agenr-ai/agenr/discussions)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
