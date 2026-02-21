# AGENTS.md

> CLAUDE.md is a symlink to this file. Edit AGENTS.md only.

## What is agenr?

Human memory for AI agents. Extract structured knowledge from conversations, store with semantic dedup, recall with memory-aware ranking, consolidate over time.

## Stack

- TypeScript, ESM, Node.js 20+
- libsql/SQLite for storage (`@libsql/client`)
- sqlite-vec for vector similarity search
- OpenAI `text-embedding-3-small` (1024 dims) for embeddings
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
  cli-main.ts         # CLI main entry (invoked by cli.ts)
  extractor.ts        # LLM extraction from transcripts
  dedup.ts            # Per-batch dedup (trigram Jaccard, pre-store filter)
  parser.ts           # File parsing (JSONL, markdown, plain text)
  schema.ts           # TypeBox schemas for extraction
  types.ts            # Core types, enums
  config.ts           # Config file management (~/.agenr/config.json)
  setup.ts            # Interactive setup (provider/auth/model)
  auth-status.ts      # Auth diagnostics
  output.ts           # Output formatting
  platform.ts         # Platform detection and defaults
  project.ts          # Project auto-detection from CWD
  shutdown.ts         # Graceful shutdown helpers
  ui.ts               # Shared UI utilities
  version.ts          # Version constant
  adapters/           # Source format adapters (per-platform JSONL parsing)
    types.ts           # Adapter interface
    registry.ts        # Adapter registry
    jsonl-base.ts      # Base JSONL adapter
    jsonl-generic.ts   # Generic JSONL fallback
    jsonl-registry.ts  # JSONL adapter registry
    openclaw.ts        # OpenClaw adapter
    claude-code.ts     # Claude Code adapter
    codex.ts           # Codex adapter
    cursor.ts          # Cursor adapter
    vscode-copilot.ts  # VS Code Copilot adapter
    plaud.ts           # Plaud transcript adapter
    text.ts            # Plain text adapter
  cli/
    option-parsers.ts  # Shared CLI option parsing helpers
  commands/
    consolidate.ts     # Consolidation CLI (orchestrates rules + LLM tiers)
    context.ts         # Context file generation CLI
    daemon.ts          # Daemon install/start/stop/restart
    db.ts              # DB management (stats, export, reset, rebuild-index, check)
    eval.ts            # Recall scoring eval/regression
    health.ts          # DB health check and forgetting candidate stats
    ingest.ts          # Bulk ingestion from files/directories
    mcp.ts             # MCP server launcher
    recall.ts          # Recall CLI
    reset.ts           # DB reset --full command
    retire.ts          # Entry retirement CLI
    shared.ts          # Shared command helpers
    store.ts           # Store CLI
    todo.ts            # Todo done/complete CLI
    watch.ts           # Watch mode CLI
  db/
    client.ts          # DB connection + initialization
    lockfile.ts        # Process lock (prevent concurrent writes)
    retirements.ts     # Retirements ledger (retirements.json)
    schema.ts          # Table definitions + column migrations
    store.ts           # Store pipeline (dedup, embed, insert)
    stored-entry.ts    # StoredEntry mapping from raw DB rows
    recall.ts          # Recall scoring (vector + recency + importance + FTS)
    relations.ts       # Entry relations
    session-start.ts   # Session-start bootstrap recall
    vector-index.ts    # Vector index management (rebuild, check)
  consolidate/
    rules.ts           # Tier 1: deterministic rules (expiry, near-exact dedup)
    cluster.ts         # Tier 2: union-find clustering with diameter cap
    merge.ts           # Tier 2: LLM-assisted merge via tool calls
    orchestrate.ts     # Consolidation orchestration (was lock.ts; locking moved to src/db/lockfile.ts)
    verify.ts          # Tier 2: semantic verification + review queue
    util.ts            # Shared utilities (UnionFind, cosineSim, etc.)
  mcp/
    server.ts          # MCP stdio server (4 tools: recall, store, extract, retire)
  llm/
    client.ts          # LLM client abstraction
    models.ts          # Model resolution
    credentials.ts     # Credential discovery (API keys, CLI creds, keychain)
    stream.ts          # Streaming output (runSimpleStream)
  embeddings/
    client.ts          # OpenAI embeddings (batch, retry, concurrency)
    cache.ts           # Embedding cache
  utils/
    entry-utils.ts     # Entry helper utilities
    string.ts          # String utilities
  watch/
    watcher.ts         # File watcher (auto-extract + store on change)
    state.ts           # Watch state tracking
    platform-defaults.ts  # Per-platform default watch directories
    session-resolver.ts   # Active session file resolution
    resolvers/         # Per-platform active file resolvers
      index.ts
      auto.ts
      claude-code.ts
      codex.ts
      mtime.ts
      openclaw.ts
tests/                 # vitest test files
  consolidate-*.test.ts  # Consolidation tests (cluster, merge, verify, e2e)
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
  prompts/             # Codex prompt specs (gitignored - local only)
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

- Run `pnpm test -- --run` before committing (NOT `bun test` -- bun's fake timer implementation hangs on retry tests)
- Tests use in-memory SQLite (`:memory:`) - no external deps needed
- Test files live in `tests/` and mirror `src/` structure
- When fixing a bug, add a regression test that would have caught it
- Mock LLM calls in unit tests - don't make real API calls

## Key types

Seven knowledge types: `fact`, `decision`, `preference`, `todo`, `relationship`, `event`, `lesson`

Importance: integer 1-10
- 7: default workhorse -- stored silently, no signal fires
- 8+: fires real-time cross-session signal -- use only when another active
      session needs this NOW; no more than 20% of entries should be 8+
- 9: critical breaking changes or immediate cross-session decisions only
- 10: once-per-project permanent constraints (use sparingly)
- 6: routine dev observations (verified X, confirmed Y runs, tests passing)
- 5: borderline -- only store if clearly durable beyond today
- OpenClaw extractor confidence rule: hedged, unverified assistant factual
      claims are tagged `unverified` and capped at importance 5
Expiry: `session-only`, `temporary`, `permanent`, `core`
Scope: `private`, `shared`, `public`

All defined in `src/types.ts` with TypeBox schemas in `src/schema.ts`.

## Store pipeline

The store pipeline in `src/db/store.ts` has layered dedup:

1. **Content hash** - exact content match (cheapest, runs first)
2. **Vector similarity bands** (cosine against existing entries):
   - `>= 0.95` (same type) - auto-skip (near-exact duplicate)
   - `>= 0.88` (same subject + same type) - reinforce (bump confirmations)
   - `0.88-0.95` (same subject, different type) - create "related" relation
   - `>= 0.72` default / `>= 0.62` aggressive - LLM decision path
   - below threshold - insert as new

Key functions: `hasContentHash`, `findSimilar`, `composeEmbeddingText`, `markSuperseded`

## Consolidation

Two-tier system in `src/consolidate/`:

- **Tier 1 (rules):** Expire decayed entries (recency < 0.05), merge near-exact dupes (cosine >= 0.95, same type + same subject). No LLM.
- **Tier 2 (LLM):** Union-find clustering (same-type threshold 0.85, cross-type 0.89, diameter cap threshold-0.02). Min cluster size 3, max 12. LLM merges via tool calls. Embedding verification (>= 0.65 per-source, >= 0.75 centroid). Flagged merges go to review queue.
- **Lock:** `src/db/lockfile.ts` prevents concurrent consolidation runs
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
- **CHANGELOG.md must be updated for every PR.** Add a new version block with the correct next version number. Do not reuse an existing block. Do not open a PR without it. If the CHANGELOG was pre-written by someone else, verify the description matches what you actually implemented and correct it if not.

## Docs

Keep docs up to date when changing related code. Stale docs are worse than no docs.

- If you change the importance calibration or SYSTEM_PROMPT in
  `src/extractor.ts`, update: `docs/guides/scenarios.md` (importance table
  and Gotcha 18), `docs/OPENCLAW.md` (Teaching Your Agent section),
  `docs/MCP.md` (Teach Your AI section), and `AGENTS.md` (Key types section).
- `docs/ARCHITECTURE.md` - system design, scoring formulas, schema
- `docs/CLI.md` - full command/flag reference
- `docs/MCP.md` - MCP server setup and tool schemas
- `docs/CONSOLIDATION.md` - two-tier consolidation design
- `docs/CONFIGURATION.md` - env vars, auth methods, config file
- `docs/OPENCLAW.md` - OpenClaw integration guide
- `CHANGELOG.md` - user-facing changes by version
- `README.md` - install, quickstart, feature overview

## Repo Workflow

This is a public open-source repo. Follow this flow for all changes:

1. **Issue first** - Every feature/bug gets a GitHub Issue before work starts
2. **Branch from master** - Branch naming convention:
   - `feat/` - new features (`feat/daemon-commands`)
   - `fix/` - bug fixes (`fix/reset-file-drain`)
   - `chore/` - maintenance, docs, refactoring
   - `hotfix/` - urgent production fixes
3. **Commit message references issue** - Include "Closes #N" in the commit message or PR body
4. **Push and create PR** - Push your branch and open a PR via `gh` CLI or the GitHub web UI.
5. **CodeRabbit reviews** - Automated code review on every PR. Address actionable findings before merge.
6. **Approve and merge** - Rebase merge only (linear history). Branch protection requires 1 approval.
7. **Clean up** - Delete branch after merge (local and remote)

**Branch protection (master):**
- Require PR before merging (1 approval)
- Rebase merge only
- No force pushes, no deletions

**Labels:** `enhancement`, `bug`, `good first issue`
**Milestones:** Group issues by release (v0.5, etc.)

## Completion Checklist

Before pushing your branch and opening a PR, verify every applicable item:

- [ ] All code changes are complete and tested (`pnpm test -- --run` passes)
- [ ] **CHANGELOG.md** - new `[x.y.z]` version block added with accurate description of what changed
- [ ] **package.json** - `version` field bumped to match the CHANGELOG block
- [ ] Docs updated for anything user-facing (CLI flags, config, behavior changes)
- [ ] No em-dashes in any modified file (use hyphens)
- [ ] No `any` types introduced

The task is not complete until CHANGELOG.md and package.json are updated. A PR missing either will be rejected.
