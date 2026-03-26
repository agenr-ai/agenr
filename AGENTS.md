# AGENTS.md

> CLAUDE.md is a symlink to this file. Edit AGENTS.md only.

## What is agenr?

Memory infrastructure for AI agents. Ingest conversation transcripts, extract durable knowledge, store with semantic dedup, recall with memory-aware ranking, and maintain corpus health via surgeon. Designed as a universal brain — any agent system (OpenClaw, Cursor, Windsurf, etc.) plugs in via adapters or the HTTP API.

## Stack

- TypeScript, ESM, Node.js 24+
- libsql/SQLite for storage (`@libsql/client`) — designed for future Turso edge migration
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
├── core/                    # THE INSIDE — pure logic, zero I/O dependencies
│   ├── types.ts             # Domain types: Entry, RecallQuery, StoreResult, etc.
│   ├── ports.ts             # ALL port interfaces: DatabasePort, EmbeddingPort, LlmPort, TranscriptPort
│   ├── store/               # Entry validation, dedup logic, store pipeline
│   ├── recall/              # Scoring, ranking, candidate selection, session-start
│   ├── ingestion/           # Chunking, extraction primitives, prompts
│   └── surgeon/             # Consolidation, dedup, retirement rules
│
├── app/                     # Application orchestration — composes ports into workflows
│   └── ingestion/           # Multi-file ingest services, concurrency, progress, file ports
│
├── adapters/                # THE OUTSIDE — infrastructure implementations
│   ├── db/                  # SQLite: schema, queries, client (implements DatabasePort)
│   ├── files/               # Local transcript discovery + hashing adapters
│   ├── embeddings.ts        # Embedding API client (implements EmbeddingPort)
│   ├── llm.ts               # LLM API client (implements LlmPort)
│   ├── api/                 # HTTP REST API — universal adapter for any agent
│   ├── openclaw/            # OpenClaw plugin adapter (implements TranscriptPort, plugin hooks)
│   └── mcp/                 # MCP server adapter
│
├── cli/                     # CLI adapter — thin, wires adapters to core
│   ├── main.ts              # Entry point + command registration
│   └── commands/            # One file per command
│
└── config.ts                # Config loading + types

tests/                       # vitest test files, mirrors src/ structure
docs/                        # Documentation
```

### Layering rules

- **`core/`** is pure logic. No IO, no database, no HTTP, no file system access, and no process-global logging. It depends only on port interfaces defined in `core/ports.ts`. All domain types live in `core/types.ts`.
- **`app/`** coordinates workflows that compose multiple ports or adapters. Concurrency, file discovery/hashing, cross-step orchestration, and progress reporting belong here when they are not pure domain logic.
- **`adapters/`** implement port interfaces and translate external protocols (SQLite, HTTP, OpenClaw plugin API, MCP, embedding APIs) into core API calls. Adapters may import from `core/` (types + ports). Adapters must NOT import from other adapters.
- **`cli/`** is a thin shell. Commands parse args, wire adapters and app services, call core/app functions, format output. No workflow orchestration or business logic lives here.
- **`config.ts`** is shared infrastructure — both core and adapters may reference config types.

### OpenClaw plugin architecture

The plugin at `adapters/openclaw/` is the most complex adapter but must stay disciplined. It is a **translator, not a brain.**

Every piece of code in the plugin should be one of:

1. **A core call** — `core.recall()`, `core.store()`, `core.handoffSession()`, etc.
2. **OpenClaw protocol translation** — mapping OpenClaw events/hooks (`before_prompt_build`, `before_reset`, tool invocations) to core calls, and formatting core results for OpenClaw's prompt injection format
3. **OpenClaw-specific logic** — session predecessor lookup (parsing OpenClaw session keys), transcript building from OpenClaw's message format, handoff dedup, tool registration

The test for where logic belongs: **would a Cursor or Windsurf adapter need the same logic?** If yes, it belongs in `core/`. If it's specific to how OpenClaw structures sessions, messages, or hooks, it belongs in the plugin.

Examples:

- Recall scoring and ranking → `core/` (any adapter needs this)
- Handoff workflow (store fallback → LLM summarize → retire fallback) → `core/` (any adapter would do this)
- Building a transcript from OpenClaw `.jsonl` messages → plugin (OpenClaw-specific format)
- Parsing OpenClaw session keys to find predecessors → plugin (OpenClaw-specific)
- Formatting recalled entries for system prompt injection → plugin (OpenClaw's prompt format)
- Importance rules, dedup logic, extraction → `core/` (never in the plugin)

Plugin directory structure - grouped by concern:

```
adapters/openclaw/
├── index.ts                    # Plugin entry point, hook registration, wiring
├── types.ts                    # OpenClaw-specific type definitions
├── tools.ts                    # Tool registration + handlers (store, retire, update, trace, recall)
├── transcript/                 # Ingestion: JSONL parsing
│   └── parser.ts              # TranscriptPort implementation
├── hooks/                      # OpenClaw lifecycle event handlers
│   ├── session-start.ts       # before_prompt_build → core.recall.sessionStart()
│   ├── handoff.ts             # before_reset → core.handoff()
│   └── mid-session-recall.ts  # On-demand recall during session
├── session/                    # Session lifecycle + state (OpenClaw-specific)
│   ├── predecessor.ts         # Parse session key, find prior handoff entry
│   ├── state.ts               # In-memory tracking (handoff dedup, seen sessions)
│   └── handoff-transcript.ts  # Build transcript from OpenClaw messages
└── format/                     # Output formatting
    └── recall-format.ts       # Format entries for OpenClaw prompt injection
```

Organizing principles:

- **`hooks/`** — one file per OpenClaw lifecycle event, each translates to core calls
- **`session/`** — OpenClaw-specific session lifecycle (predecessor, state, transcript building)
- **`transcript/`** and **`format/`** — input parsing and output formatting
- Root files (`index.ts`, `tools.ts`, `types.ts`) are cross-cutting

### Why hexagonal?

The core API is the real product. Adapters translate protocols:

- OpenClaw plugin → `core.recall()`, `core.store()`, `core.sessionStart()`
- HTTP API → same core calls
- CLI → same core calls
- Future Cursor adapter → same core calls

Adding a new agent system = write an adapter. Zero core changes.

## Entry types

- `fact` — durable descriptive state
- `decision` — choices, rules, requirements, constraints with rationale
- `preference` — stated preferences
- `lesson` — learned insights, what worked/didn't
- `event` — notable occurrences worth remembering
- `relationship` — connections between entities
- `todo` — tracked action items
- `reflection` — synthesized observations (typically system-generated)

## Importance scale (1-10)

The extraction LLM assigns importance based on knowledge type and signal strength:

- **9-10:** Foundational constraints, identity, core values, critical infrastructure
- **7-8:** Decisions with rationale, strong preferences, recurring lessons, architectural choices
- **5-6:** Verified facts, routine observations, one-time context
- **3-4:** Tentative/uncertain information, ephemeral context
- **1-2:** Barely worth storing (probably should not be extracted)

## Expiry

- `core` — always injected at session start (rare, expensive)
- `permanent` — durable, recalled on demand
- `temporary` — short-horizon, subject to automatic expiry

## Database

Single SQLite database with ~7 tables. No migrations — if the schema changes, reset and re-ingest. Tags are a JSON array on the entries table (no separate tags table).

Key tables: `entries`, `entries_fts` (FTS5), `ingest_log`, `recall_events`, `surgeon_runs`, `_meta`.

## No projects, no platforms

All entries live in one flat namespace. No `project` column, no `platform` column, no project-scoped recall. Tags can serve as lightweight "relates to X" signal if needed in the future.

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

- `sandbox-agenr` — runs agenr CLI against sandbox DB
- `sandbox-openclaw` — runs OpenClaw gateway loading plugin from local build

VS Code launch configs are pre-configured for debugging against the sandbox with sourcemaps.

**Dev loop (human):** `edit → pnpm build:debug → F5 → breakpoints`
**Dev loop (agent):** `pnpm build → sandbox-agenr <command> --verbose → inspect`
**Verify DB state:** `sqlite3 ~/.openclaw-sandbox/agenr-data/knowledge.db "SELECT ..."`

## CLI commands

```
agenr ingest <path> [options]     # Ingest session files
agenr recall <query> [options]    # Search knowledge
agenr store [options]             # Store entry
agenr retire <id|subject>         # Retire an entry
agenr update <id|subject>         # Update importance/expiry
agenr trace <id|subject>          # Trace entry provenance
agenr surgeon [options]           # Run maintenance
agenr mcp                         # Start MCP server
agenr db reset                    # Reset database
agenr db stats                    # Show statistics
agenr db path                     # Print DB path
agenr setup                       # Interactive setup
agenr config                      # Show/edit config
```

Every command supports `--verbose` and `--dry-run` for agent debuggability.

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
- Tests use in-memory SQLite (`:memory:`) — no external deps needed
- Test files live in `tests/` and mirror `src/` structure
- Core modules tested with test doubles (mock ports)
- Adapters integration-tested against sandbox
- When fixing a bug, add a regression test

## Code style

- No `any` types — use proper TypeScript types
- Errors should be descriptive and actionable
- Keep functions focused — if it's doing two things, split it
- No em-dashes — use hyphens
- Prefer composition over inheritance
- Use `type` imports (enforced by ESLint)
- **Google-style JSDoc on all exported functions, interfaces, and types.** Every public API must have a `/** */` docstring explaining what it does, its parameters, and return value. Internal/private helpers are encouraged but not required.
- Follow SOLID principles

## Repo workflow

1. **Issue first** — every feature/bug gets a GitHub issue
2. **Branch from master** — `feat/`, `fix/`, `chore/`, `hotfix/`
3. **Commit references issue** — include "Closes #N" or "Ref #N"
4. **PR and review** — keep master linear, prefer squash merge
5. **Clean up** — delete branch after merge

## Completion checklist

Before pushing:

- [ ] `pnpm check` passes and no warnings
- [ ] Docs updated for user-facing changes
- [ ] No `any` types introduced
- [ ] No em-dashes in modified files
- [ ] Core has zero imports from adapters (ESLint catches this)
- [ ] New tests for new behavior
