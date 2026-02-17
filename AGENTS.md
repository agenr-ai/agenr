# AGENTS.md

> CLAUDE.md is a symlink to this file. Edit AGENTS.md only.

## What is agenr?

Local-first memory for AI agents. Extract structured knowledge from conversations, store with semantic dedup, recall with memory-aware ranking, consolidate over time.

**Version:** 0.4.0

## Stack

- TypeScript, ESM, Node.js 20+
- libsql/SQLite for storage (`@libsql/client`)
- sqlite-vec for vector similarity search
- OpenAI `text-embedding-3-small` (512 dims) for embeddings
- `@mariozechner/pi-ai` for LLM (structured output via tool calling)
- `@sinclair/typebox` for runtime schemas
- `@clack/prompts` + `chalk` for CLI UI
- `commander` for CLI argument parsing
- pnpm (not npm/yarn)
- vitest for tests, tsup for bundling

## Project structure

```
src/
  cli.ts              # CLI entry point (commander)
  extractor.ts        # LLM extraction from transcripts
  dedup.ts            # Per-batch dedup (trigram Jaccard, pre-store filter)
  parser.ts           # File parsing (JSONL, markdown, plain text)
  schema.ts           # TypeBox schemas for extraction
  types.ts            # Core types, enums
  config.ts           # Config file management (~/.agenr/config.json)
  setup.ts            # Interactive setup (provider/auth/model)
  auth-status.ts      # Auth diagnostics
  output.ts           # Output formatting
  ui.ts               # Shared UI utilities
  commands/
    consolidate.ts     # Consolidation CLI (orchestrates rules + LLM tiers)
    db.ts              # DB management (stats, export, reset, rebuild-index, check)
    ingest.ts          # Bulk ingestion from files/directories
    mcp.ts             # MCP server launcher
    recall.ts          # Recall CLI
    store.ts           # Store CLI
    watch.ts           # Watch mode CLI
  db/
    client.ts          # DB connection + initialization
    schema.ts          # Table definitions + indexes/triggers/fts
    store.ts           # Store pipeline (dedup, embed, insert)
    recall.ts          # Recall scoring (vector + recency + confidence + FTS)
    relations.ts       # Entry relations
    session-start.ts   # Session-start bootstrap recall
    vector-index.ts    # Vector index management (rebuild, check)
  consolidate/
    rules.ts           # Tier 1: deterministic rules (expiry, near-exact dedup)
    cluster.ts         # Tier 2: union-find clustering with diameter cap
    merge.ts           # Tier 2: LLM-assisted merge via tool calls
    verify.ts          # Tier 2: semantic verification + review queue
    lock.ts            # Process lock (prevent concurrent consolidation)
    util.ts            # Shared utilities (UnionFind, cosineSim, etc.)
  mcp/
    server.ts          # MCP stdio server (3 tools: recall, store, extract)
  llm/
    client.ts          # LLM client abstraction
    models.ts          # Model resolution
    credentials.ts     # Credential discovery (API keys, CLI creds, keychain)
    stream.ts          # Streaming output (runSimpleStream)
  embeddings/
    client.ts          # OpenAI embeddings (batch, retry, concurrency)
    cache.ts           # Embedding cache
  watch/
    watcher.ts         # File watcher (auto-extract + store on change)
    state.ts           # Watch state tracking
tests/                 # vitest test files
  consolidate-*.test.ts  # Consolidation tests (cluster, merge, verify, lock, e2e)
  consolidate/           # Consolidation test fixtures
  db/                    # DB test helpers
  embeddings/            # Embedding test mocks
  mcp/                   # MCP server tests
  watch/                 # Watch mode tests
  integration/           # Integration tests
  fixtures/              # Shared test fixtures
docs/
  ARCHITECTURE.md      # System design, scoring formulas, schema
  CLI.md               # Full command/flag reference
  MCP.md               # MCP server setup and tool schemas
  CONSOLIDATION.md     # Two-tier consolidation design
  CONFIGURATION.md     # Env vars, auth methods, config file
  OPENCLAW.md          # OpenClaw integration guide
  prompts/             # Codex prompt specs for upcoming work
```

## Common commands

```bash
pnpm install           # Install deps
pnpm build             # Build with tsup (output: dist/)
pnpm test              # Run all tests (watch mode)
pnpm test -- --run     # Run all tests once (CI mode)
pnpm exec agenr        # Run CLI from source
```

## Testing

- Run `pnpm test -- --run` before committing
- Tests use in-memory SQLite (`:memory:`) - no external deps needed
- Test files live in `tests/` and mirror `src/` structure
- When fixing a bug, add a regression test that would have caught it
- Mock LLM calls in unit tests - don't make real API calls

## Key types

Seven knowledge types: `fact`, `decision`, `preference`, `todo`, `relationship`, `event`, `lesson`

Confidence: `low`, `medium`, `high`
Expiry: `session-only`, `temporary`, `permanent`, `core`
Scope: `private`, `shared`, `public`

All defined in `src/types.ts` with TypeBox schemas in `src/schema.ts`.

## Store pipeline

The store pipeline in `src/db/store.ts` has layered dedup:

1. **Content hash** - exact content match (cheapest, runs first)
2. **Vector similarity bands** (cosine against existing entries):
   - `>= 0.98` (same type) - auto-skip (near-exact duplicate)
   - `0.92-0.98` (same subject + same type) - reinforce (bump confirmations)
   - `0.92-0.98` (same subject, different type) - create "related" relation
   - `0.80-0.92` (same subject, `--classify` flag) - LLM classify relationship
   - `< 0.80` - insert as new

Key functions: `hasContentHash`, `findSimilar`, `composeEmbeddingText`, `markSuperseded`

## Consolidation

Two-tier system in `src/consolidate/`:

- **Tier 1 (rules):** Expire decayed entries (recency < 0.05), merge near-exact dupes (cosine >= 0.95, same type + same subject). No LLM.
- **Tier 2 (LLM):** Union-find clustering (same-type threshold 0.85, cross-type 0.89, diameter cap threshold-0.02). Min cluster size 3, max 12. LLM merges via tool calls. Embedding verification (>= 0.65 per-source, >= 0.75 centroid). Flagged merges go to review queue.
- **Lock:** `acquireLock()`/`releaseLock()` prevents concurrent runs
- **Provenance:** `entry_sources` table tracks merged entry lineage

## Per-batch dedup

`src/dedup.ts` runs before store as a pre-filter:
- Groups entries by `type|subject`
- Trigram Jaccard similarity >= 0.85 within groups
- Catches lexical dupes within a single extraction batch (cheap, no LLM)

## Code style

- No `any` types - use proper TypeScript types
- Errors should be descriptive and actionable
- Use existing patterns in the codebase - check similar files before writing new code
- Keep functions focused - if it's doing two things, split it
- No em-dashes - use hyphens

## Backward compatibility

This project is live on npm. Existing users have databases and configs that must keep working:
- Database schema changes need ALTER TABLE migrations in initSchema
- Config format changes need fallbacks for old formats
- CLI flag changes should be backward-compatible (add new flags, don't rename old ones)
- Test migrations against databases created by previous versions
- Update CHANGELOG.md with every user-facing change (added, changed, fixed, removed)

## Docs

Keep these up to date when changing related code. If you add a CLI flag, update CLI.md. If you change scoring, update ARCHITECTURE.md. Stale docs are worse than no docs.

- `docs/ARCHITECTURE.md` - system design, scoring formulas, schema
- `docs/CLI.md` - full command/flag reference
- `docs/MCP.md` - MCP server setup and tool schemas
- `docs/CONSOLIDATION.md` - two-tier consolidation design
- `docs/CONFIGURATION.md` - env vars, auth methods, config file
- `docs/OPENCLAW.md` - OpenClaw integration guide
- `CHANGELOG.md` - user-facing changes by version
- `README.md` - install, quickstart, feature overview

## Memory (agenr MCP)

If you have agenr MCP configured, use it:
- On session start: `agenr_recall` with context `session-start`
- When working on a feature: recall related topics
- When you make a significant decision: store it with `agenr_store`
