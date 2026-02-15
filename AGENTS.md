# AGENTS.md

> CLAUDE.md is a symlink to this file. Edit AGENTS.md only.

## What is agenr?

Local-first memory for AI agents. Extract structured knowledge from conversations, store with semantic dedup, recall with memory-aware ranking, consolidate over time.

## Stack

- TypeScript, ESM, Node.js 20+
- libsql/SQLite for storage (`@libsql/client`)
- OpenAI `text-embedding-3-small` (512 dims) for embeddings
- pnpm (not npm/yarn)
- vitest for tests, tsup for bundling

## Project structure

```
src/
  cli.ts              # CLI entry point (commander)
  commands/            # Command handlers (extract, store, recall, consolidate, etc.)
  db/
    client.ts          # DB connection + migrations
    schema.ts          # Table definitions + migrations
    store.ts           # Store pipeline (dedup, embed, insert)
    recall.ts          # Recall scoring (vector + recency + confidence + FTS)
    relations.ts       # Entry relations
  consolidate/
    rules.ts           # Tier 1: deterministic rules (expiry, near-exact dedup)
    cluster.ts         # Tier 2: union-find clustering with diameter cap
    merge.ts           # Tier 2: LLM-assisted merge
    verify.ts          # Tier 2: semantic verification + review queue
    lock.ts            # Consolidation lock (prevent concurrent runs)
    util.ts            # Shared utilities
  mcp/
    server.ts          # MCP stdio server (3 tools: recall, store, extract)
  llm/
    client.ts          # LLM client
    models.ts          # Model resolution
    credentials.ts     # Credential discovery (API keys, CLI creds, keychain)
  embeddings/
    client.ts          # OpenAI embeddings (batch, retry, concurrency)
  types.ts             # Core types, enums, schemas (TypeBox)
  config.ts            # Config file management
  parser.ts            # File parsing (JSONL, markdown, plain text)
tests/                 # vitest test files (mirror src/ structure)
docs/                  # Architecture, CLI, MCP, consolidation docs
```

## Common commands

```bash
pnpm install           # Install deps
pnpm build             # Build with tsup (output: dist/)
pnpm test              # Run all tests
pnpm test -- --run     # Run tests without watch mode
pnpm exec agenr        # Run CLI from source
```

## Testing

- Run `pnpm test -- --run` before committing
- Tests use in-memory SQLite (`:memory:`) — no external deps needed
- Test files live in `tests/` and mirror `src/` structure
- When fixing a bug, add a regression test that would have caught it

## Key types

Seven knowledge types: `fact`, `decision`, `preference`, `todo`, `relationship`, `event`, `lesson`

Confidence: `low`, `medium`, `high`
Expiry: `session-only`, `temporary`, `permanent`, `core`
Scope: `private`, `shared`, `public`

All defined in `src/types.ts` with TypeBox schemas.

## Store pipeline thresholds

- `>0.98` cosine — skip (near-exact duplicate)
- `0.92–0.98` — reinforce existing entry (bump confirmations)
- `0.80–0.92` — classify relationship (with `--classify` flag)
- `<0.80` — insert as new

## Consolidation thresholds

- Tier 1 rules: `0.95` (near-exact dedup), `0.05` (expiry score)
- Tier 2 clustering: `0.85` (same-type), `0.89` (cross-type), diameter cap `threshold - 0.02`
- Verification: `0.65` per-source, `0.75` centroid

## Code style

- No `any` types — use proper TypeScript types
- Errors should be descriptive and actionable
- Use existing patterns in the codebase — check similar files before writing new code
- Keep functions focused — if it's doing two things, split it

## Docs

- `docs/ARCHITECTURE.md` — system design, scoring formulas, schema
- `docs/CLI.md` — full command/flag reference
- `docs/MCP.md` — MCP server setup and tool schemas
- `docs/CONSOLIDATION.md` — two-tier consolidation design
- `docs/CONFIGURATION.md` — env vars, auth methods, config file
- `CONTRIBUTING.md` — contribution guidelines

## Memory (agenr MCP)

If you have agenr MCP configured, use it:
- On session start: `agenr_recall` with context `session-start`
- When working on a feature: recall related topics
- When you make a significant decision: store it with `agenr_store`
