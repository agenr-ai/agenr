# AGENTS.md

> CLAUDE.md is a symlink to this file. Edit AGENTS.md only.

## What is agenr?

Memory infrastructure for AI agents. Ingest conversation transcripts, extract durable knowledge, store with semantic dedup, recall with memory-aware ranking, maintain episodic summaries, and keep corpus health in shape with surgeon. OpenClaw is the current production adapter, the repo also contains a narrow internal recall-eval HTTP seam, and the core stays shaped so future adapters can plug in cleanly.

## Stack

- TypeScript, ESM, Node.js 24+
- libsql/SQLite for storage (`@libsql/client`) - designed for future Turso edge migration
- libsql vector index for vector similarity search (1024-dim, cosine)
- OpenAI `text-embedding-3-small` (1024 dims) for embeddings
- `commander` for CLI argument parsing
- `chalk` for CLI output
- pnpm (not npm/yarn)
- vitest for tests, tsup for bundling

## Architecture: Hexagonal (Ports & Adapters)

**The one rule: `src/core/` never imports from `src/adapters/`, `src/cli/`, or process-global logging/file-system helpers.** This is enforced by ESLint.

```
src/
├── core/                    # THE INSIDE - pure logic, zero I/O dependencies
│   ├── types.ts             # Shared domain types for entries, episodes, and transcripts
│   ├── ports.ts             # Core port interfaces: DatabasePort, RecallPorts, EmbeddingPort, LlmPort, TranscriptPort
│   ├── store/               # Entry validation, hash dedup, embedding text, store pipeline
│   ├── recall/              # Entry recall parsing, candidate merge, scoring, temporal helpers
│   ├── episode/             # Episodic search, temporal windows, summary prompt/types
│   ├── ingestion/           # Transcript extraction, chunking, prompt parsing, semantic dedup
│   └── surgeon/domain/      # Protection rules and action types shared by surgeon workflows
│
├── app/                     # Application orchestration - composes ports into workflows
│   ├── ingestion/           # Multi-file durable-entry ingest orchestration
│   ├── episode-ingest/      # Episode backfill planning, preflight, execution, embedding backfill
│   ├── recall/              # Unified entry + episode recall routing
│   ├── surgeon/             # Surgeon runtime, tools, prompts, budgets, completion guards
│   ├── openclaw/            # Shared runtime wiring for the OpenClaw plugin
│   └── evals/recall/        # Internal recall-eval execution seam and diagnostics
│
├── adapters/                # THE OUTSIDE - infrastructure implementations
│   ├── db/                  # SQLite/libSQL schema and query adapters
│   ├── files/               # Local transcript discovery and hashing
│   ├── embeddings.ts        # Embedding API client
│   ├── llm.ts               # LLM client and auth helpers
│   ├── api/                 # Narrow internal recall-eval HTTP transport
│   ├── openclaw/            # OpenClaw memory plugin runtime, tools, hooks, transcript/session adapters
│   ├── surgeon/             # Surgeon trace adapter helpers
│   └── mcp/                 # Reserved for future MCP adapter work
│
├── cli/                     # CLI adapter - thin command registration and formatting
│   ├── main.ts              # Entry point + command registration
│   └── commands/            # One file or namespace per CLI command
│
├── config.ts                # Config loading + types
└── cli.ts                   # CLI bootstrap

packages/
└── openclaw-plugin/         # Published OpenClaw plugin package wrapper

tests/                       # vitest test files, mirrors src/ structure
docs/                        # Documentation
```

### Layering rules

- **`core/`** is pure logic. No IO, no database, no HTTP, no file system access, and no process-global logging. It depends only on port interfaces defined in `core/ports.ts`. All domain types live in `core/types.ts`.
- **`app/`** coordinates workflows that compose multiple ports or adapters. Concurrency, file discovery/hashing, cross-step orchestration, and progress reporting belong here when they are not pure domain logic.
- **`adapters/`** implement port interfaces and translate external protocols (SQLite, the internal recall-eval HTTP seam, OpenClaw plugin APIs, embedding APIs) into core or app calls. Adapters may import from `core/` and targeted `app/` services, but should not reach across unrelated adapter packages.
- **`cli/`** is a thin shell. Commands parse args, wire adapters and app services, call core/app functions, format output. No workflow orchestration or business logic lives here.
- **`config.ts`** is shared infrastructure - runtime config loading and types used by CLI, app, and adapters.
- **`core/`** must not call `process.exit()` or read `process.env` directly - pass configuration through ports or function parameters.
- **`src/adapters/openclaw/`** must keep filesystem access async - use `node:fs/promises`, never `node:fs`.
- **`src/core/`** and **`src/adapters/openclaw/`** must not block the host with sync filesystem helpers or terminate the host process.
- Env flags must use explicit string comparisons such as `"true"` or `"1"` - never rely on truthiness of `process.env.*`.

### Recall eval adapter scope guardrails

The internal recall-eval HTTP seam under `src/adapters/api/` is intentionally narrow.

1. `agenr` owns only the execution seam for recall evals.
2. `agenr-evals` owns manifests, suite orchestration, scoring, summaries, and benchmark reporting.
3. Keep the transport to the single internal recall-case HTTP route and its validation contract.
4. Route handlers must stay thin and delegate to an app service.
5. `core/` may expose typed execution facts for observability, but must not gain eval-specific logging, file writing, or artifact policy.
6. Do not add eval-only CLI commands as the main transport.
7. Do not add a second eval family, second provisioning mode, or broad memory-management API without an explicit design review.
8. Before adding new adapter fields or behaviors, ask whether they belong in `agenr-evals` instead.

### OpenClaw plugin architecture

The OpenClaw runtime lives in `src/adapters/openclaw/` and is packaged by `packages/openclaw-plugin/`. It is a **translator, not a brain.**

Every piece of code in the plugin should be one of:

1. **A core call or app workflow call** - `core/store`, `core/recall`, `app/runUnifiedRecall`, `app/episode-ingest`, etc.
2. **OpenClaw protocol translation** - mapping `before_prompt_build`, `session_start`, memory-runtime hooks, flush-plan hooks, and tool invocations to agenr services
3. **OpenClaw-specific logic** - session key parsing, `sessions.json` fallback, prompt-section formatting, transcript parsing, embedded-agent episode summary tasks

The test for where logic belongs: **would a Cursor or Windsurf adapter need the same logic?** If yes, it belongs in `core/` or `app/`. If it's specific to how OpenClaw structures sessions, memory hooks, messages, or embedded agents, it belongs in the plugin.

Examples:

- Recall scoring and ranking -> `core/` (any adapter needs this)
- Unified routing between entries and episodes -> `app/recall/`
- Building a transcript from OpenClaw `.jsonl` messages -> plugin (OpenClaw-specific format)
- Parsing OpenClaw session keys and scanning `sessions.json` for predecessors -> plugin (OpenClaw-specific)
- Formatting recalled entries for prompt injection -> plugin (OpenClaw-specific prompt format)
- Episode temporal scoring, importance rules, dedup logic, extraction -> `core/` or `app/`, never in the plugin

Plugin directory structure - grouped by concern:

```
src/adapters/openclaw/
├── index.ts                    # Plugin entry point, hook registration, wiring
├── config.ts                   # Plugin-config validation and schema
├── runtime.ts                  # Thin re-export into app/openclaw runtime wiring
├── types.ts                    # OpenClaw-specific type definitions
├── tools/                      # Tool registration + handlers (store, recall, retire, update, trace)
├── hooks/
│   └── before-prompt-build.ts  # Session-start continuity, predecessor episode write, core-entry injection
├── session/
│   ├── continuity/             # Predecessor resolution and continuity summary readers/generators
│   ├── session-key-parser.ts   # OpenClaw session-key parsing
│   ├── session-id.ts           # Session-id derivation helpers
│   ├── sessions-store-reader.ts# `sessions.json` fallback reader
│   └── state.ts                # In-memory first-start tracking and resumedFrom state
├── transcript/                 # JSONL parsing, timestamp cleanup, tool-result summarization
├── format/                     # Prompt-section and recall-result formatting
├── episode/                    # Background predecessor-episode write path
├── memory/                     # Memory runtime registration and flush-plan support
└── embedded-agent/             # OpenClaw embedded-agent task runner wrappers
```

Organizing principles:

- **`hooks/`** - one file per OpenClaw lifecycle hook, each translating host events into agenr services
- **`session/`** - OpenClaw-specific continuity, lineage, session-key, and state logic
- **`episode/`** and **`memory/`** - host-specific episodic and memory-slot integration
- **`transcript/`**, **`format/`**, and **`embedded-agent/`** - support domains for parsing, rendering, and host-managed LLM execution
- Root files (`index.ts`, `config.ts`, `runtime.ts`, `types.ts`) are cross-cutting

### Why hexagonal?

The core API is the real product. Adapters translate protocols:

- OpenClaw plugin -> core and app workflows
- Internal recall-eval server -> `app/evals/recall/*`
- CLI -> the same core and app workflows
- Future Cursor adapter -> the same core and app workflows

Adding a new agent system = write an adapter. Zero core changes.

## Entry types

- `fact` - durable descriptive state
- `decision` - choices, rules, requirements, constraints with rationale
- `preference` - stated preferences
- `lesson` - learned insights, what worked/didn't
- `relationship` - connections between entities
- `milestone` - notable one-time occurrences, transitions, launches, and other durable happenings worth remembering

Memory authority is tiered. Durable entries are canonical memory, episodes are narrative historical recall, continuity handoffs are approximate restart context, and live verification wins when available. See `docs/RECALL.md` for the full authority model and adapter guidance.

## Importance scale (1-10)

The extraction LLM assigns importance based on knowledge type and signal strength:

- **9-10:** Foundational constraints, identity, core values, critical infrastructure
- **7-8:** Decisions with rationale, strong preferences, recurring lessons, architectural choices
- **5-6:** Verified facts, routine observations, one-time context
- **3-4:** Tentative/uncertain information, ephemeral context
- **1-2:** Barely worth storing (probably should not be extracted)

## Expiry

- `core` - always injected at session start (rare, expensive)
- `permanent` - durable, recalled on demand
- `temporary` - short-horizon, subject to automatic expiry

## Database

Single SQLite database. Agenr supports fresh databases and databases already on the current schema version only. Tags are a JSON array on the entries table (no separate tags table).

Key tables: `entries`, `entries_fts` (FTS5), `episodes`, `ingest_log`, `recall_events`, `surgeon_runs`, `surgeon_run_actions`, `_meta`.

## Projects and platforms

Entries still live in one primary namespace. The schema includes optional `project` columns on entries, episodes, and surgeon runs for scoping metadata, but agenr does not maintain separate per-platform stores or a platform-specific memory model.

## Reference codebase

The v0 codebase at `~/Code/agenr-v0` is available as reference for proven algorithms. Copy algorithms and logic, not architecture. The v0 architecture is explicitly what we're replacing.

## Sandbox

Development uses an isolated sandbox environment:

```
~/.openclaw-sandbox/                    # Sandbox home
  agenr-data/knowledge.db              # Isolated test database
  agenr-data/config.json               # Isolated config
  .openclaw/agents/main/sessions/      # Sandbox session files
  .openclaw/agents/main/real_seed_sessions_2_days/  # Real session files for testing
```

Shell wrappers:

- `sandbox-agenr` - runs agenr CLI against sandbox DB
- `sandbox-openclaw` - runs OpenClaw gateway loading plugin from local build

VS Code launch configs are pre-configured for debugging against the sandbox with sourcemaps.

**Dev loop (human):** `edit → pnpm build:debug → F5 → breakpoints`
**Dev loop (agent):** `pnpm build → sandbox-agenr <command> --verbose → inspect`
**Verify DB state:** `sqlite3 ~/.openclaw-sandbox/agenr-data/knowledge.db "SELECT ..."`

## CLI commands

```
agenr init                         # First-run onboarding wizard
agenr setup                        # Interactive auth/model/db configuration
agenr ingest <path> [options]      # Durable entry ingest (default `entries`)
agenr ingest entries <path>        # Durable entry ingest
agenr ingest episodes [path]       # Episodic summary backfill / embedding backfill
agenr recall <query> [options]     # Entry recall CLI
agenr surgeon run [options]        # Run one surgeon pass
agenr surgeon status               # Show corpus health and the latest run
agenr surgeon history [options]    # Show recent surgeon runs
agenr surgeon actions <runId>      # Show one run's audit trail
agenr db reset                     # Reset the database
```

OpenClaw also exposes these agent tools at runtime:

```
agenr_store
agenr_recall
agenr_retire
agenr_update
agenr_trace
```

Debug flags are command-specific:

- durable entry ingest exposes `--verbose` and `--dry-run`
- episode ingest exposes `--verbose`, `--dry-run`, and episode-specific backfill flags
- recall exposes `--verbose`
- surgeon run exposes `--verbose`, `--trace`, `--json`, and `--apply`

## Common commands

```bash
pnpm install           # Install deps
pnpm build             # Build with tsup
pnpm build:debug       # Build with sourcemaps
pnpm typecheck         # TypeScript validation
pnpm test              # Run all tests
pnpm check             # Full validation: format + lint + typecheck + test
```

## Testing

- Run `pnpm check` before committing
- Tests use in-memory SQLite (`:memory:`) - no external deps needed
- Test files live in `tests/` and mirror `src/` structure
- Core modules tested with test doubles (mock ports)
- Adapters integration-tested against sandbox
- When fixing a bug, add a regression test

## Code style

- No `any` types - use proper TypeScript types
- Errors should be descriptive and actionable
- Keep functions focused - if it's doing two things, split it
- No em-dashes - use hyphens
- Prefer composition over inheritance
- Use `type` imports (enforced by ESLint)
- **Google-style JSDoc on all exported functions, interfaces, and types.** Every public API must have a `/** */` docstring explaining what it does, its parameters, and return value. Internal/private helpers are encouraged but not required.
- Follow SOLID principles

## Repo workflow

1. **Issue first** - every feature/bug gets a GitHub issue
2. **Branch from master** - `feat/`, `fix/`, `chore/`, `hotfix/`
3. **Commit references issue** - include "Closes #N" or "Ref #N"
4. **PR and review** - keep master linear, prefer squash merge
5. **Clean up** - delete branch after merge

## Completion checklist

Before pushing:

- [ ] `pnpm check` passes and no warnings
- [ ] Docs updated for user-facing changes
- [ ] No `any` types introduced
- [ ] No em-dashes in modified files
- [ ] Core has zero imports from adapters (ESLint catches this)
- [ ] New tests for new behavior
