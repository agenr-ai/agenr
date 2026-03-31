# Episodes

Episodic memory gives the brain temporal awareness. While durable entries capture facts, decisions, and preferences that persist indefinitely, episodes capture _what happened_ during each session — narrative summaries tied to concrete time ranges.

This lets the agent answer questions like "what happened yesterday?", "what were we working on last week?", and "sessions about schema changes" without those answers being stored as permanent knowledge entries.

## Episodes vs Entries

| Dimension | Entries | Episodes |
|-----------|---------|----------|
| **Granularity** | Individual facts, decisions, preferences, lessons, milestones, relationships | One summary per session |
| **Lifecycle** | Persist until retired by the surgeon or manually | Persist indefinitely, regenerable from transcripts |
| **Recall mode** | Semantic similarity + lexical FTS + importance weighting | Temporal interval overlap + optional semantic rerank |
| **Source** | Extracted from transcripts by the LLM extraction pipeline | Generated per-session by the LLM summary pipeline |
| **Schema** | `entries` table with typed fields, tags, embeddings | `episodes` table with time range, surface, agent, summary, optional embedding |

## Episode Lifecycle

Episodes are generated through two paths:

### 1. Automatic — at session start

When a new session starts, the `before_prompt_build` hook detects the predecessor session and fires a best-effort background episode write. This uses OpenClaw's embedded agent runner (`runEmbeddedPiAgent`) with the agent's configured model (or the `episodeModel` override when set). The episode is written to the database with metadata from the session registry when available.

If the predecessor already has an episode, the write is skipped. If the LLM call times out or fails, the session starts normally — episode generation is never blocking.

### 2. Backfill — via CLI

```bash
agenr ingest episodes ~/.openclaw/agents/main/sessions/
```

The CLI scans a directory of OpenClaw session transcripts (including rotated `.reset.*` and `.deleted.*` files), runs preflight parsing in parallel, and generates episodes for sessions that don't already have one. This is the canonical repair path — run it after a database reset, after bulk entry ingestion, or to catch sessions that didn't get episodes at start time.

See [INGEST.md](./INGEST.md) for full CLI flag documentation.

## Episode Content

Each episode contains:

- **Summary** — a narrative paragraph describing what happened in the session
- **Time range** — `startedAt` and `endedAt` from transcript metadata
- **Surface** — where the session happened (webchat, telegram, signal, tui, subagent, heartbeat, cron)
- **Agent ID** — which OpenClaw agent ran the session
- **Activity level** — low, medium, high, or deep (derived by the LLM from conversation depth)
- **Topics** — LLM-extracted topic tags for semantic grouping
- **Source ID** — the OpenClaw session UUID, used for dedup
- **Embedding** — optional 1024-dim vector for semantic episode search

## Episode Recall

Recall routes to episodes through the unified recall layer (`src/app/recall/unified.ts`). The `mode` parameter controls routing:

| Mode | Behavior |
|------|----------|
| `auto` | Routes based on query analysis: temporal narrative → episodes, factual → entries, mixed → both |
| `entries` | Only queries durable entries |
| `episodes` | Only queries episodes |

### Auto-Routing Rules

The router inspects the query text for signals:

- **Factual phrases** (`"what decision"`, `"what's the default"`, `"which version"`) → entries only
- **Narrative phrases** (`"what happened"`, `"what were we doing"`, `"catch me up"`) + time window → episodes only
- **Narrative + topic anchor** → both episodes and entries
- **Time window without narrative** → both
- **Factual + time window** → both
- **No signals** → entries only (safe default)

### Temporal Window Parser

The parser (`src/core/episode/temporal-window.ts`) recognizes natural language time expressions and converts them to precise calendar intervals:

| Expression | Resolved to |
|------------|-------------|
| `today` | Start to end of current calendar day |
| `yesterday` | Start to end of previous calendar day |
| `this week` | Monday through current day |
| `last week` | Previous Monday through Sunday |
| `this month` | 1st through current day |
| `last month` | 1st through last day of previous month |
| `N days ago` | That single calendar day |
| `N weeks ago` | That full calendar week |
| `N months ago` | That full calendar month |
| `in March`, `in January` | Full named month (current or previous year) |
| `March 15th`, `January 1st` | That single calendar day |
| `last Friday` | Most recent occurrence of that weekday |
| ISO dates (`2026-03-15`) | That single calendar day |

All dates resolve in the system's local timezone.

## Episode Search Modes

The episode search pipeline (`src/core/episode/search.ts`) supports three modes depending on what's available:

### Pure Temporal

When no embedding is available for the query (or mode forces temporal-only), episodes are scored by interval overlap with the query time window. Scoring factors:

- **Overlap quality** — what fraction of the episode's time range intersects the query window
- **Midpoint proximity** — how close the episode's midpoint is to the query window's midpoint
- **Activity level** — higher activity episodes score higher
- **Recency** — more recent episodes get a small boost

### Pure Semantic

When no time window is detected but a query embedding is available, episodes are retrieved by vector similarity (cosine distance against the episode embedding). This handles topic-based episode queries like "sessions about database migrations".

### Hybrid

When both a time window and query embedding are available, the pipeline applies a hard temporal filter first (only episodes overlapping the time window), then reranks by semantic similarity. This handles queries like "what happened with the schema changes last week?"

## Episode Embeddings

Embeddings are generated at episode write time using the configured embedding model (`text-embedding-3-small` by default). They're stored in the `episodes` table and indexed via `idx_episodes_embedding` for vector search.

If episodes were written without embeddings (e.g., embedding API was unavailable), backfill them:

```bash
agenr ingest episodes ~/.openclaw/agents/main/sessions/ --embed-only
```

This reads existing episodes from the database and generates missing embeddings without re-running the LLM summary pipeline.

## Session Discovery

Episode ingest discovers sessions through two mechanisms:

### sessions.json Registry

OpenClaw maintains a `sessions.json` file with authoritative metadata for active sessions: surface type, agent ID, chat type, and session key. Episode ingest reads this first for accurate metadata.

### Transcript-Based Fallback

For rotated/deleted sessions not in the registry, episode ingest reconstructs metadata from the transcript itself:

- **Surface** — detected from Sender metadata blocks, Conversation info blocks, `inbound_meta` fields, and content heuristics
- **Agent ID** — derived from the directory path (`agents/{agentId}/sessions/...`)
- **Time range** — from transcript `startedAt`/`endedAt` metadata

## Architecture

Episode code follows agenr's hexagonal structure:

| Location | Responsibility |
|----------|----------------|
| `src/core/episode/` | Pure episode logic: search, scoring, temporal windows, summary generation, transcript rendering, types |
| `src/core/episode/search.ts` | Episode search pipeline (temporal, semantic, hybrid) |
| `src/core/episode/scoring.ts` | Interval overlap scoring, activity scoring, recency decay |
| `src/core/episode/temporal-window.ts` | Calendar-aware natural language time parser |
| `src/core/episode/summary-generator.ts` | LLM summary generation (core port, no infra deps) |
| `src/core/episode/summary-prompt.ts` | Episode summary system prompt and response parser |
| `src/adapters/openclaw/episode/` | OpenClaw-specific episode writer (session-start hook, embedded agent calls) |
| `src/adapters/db/` | Episode table schema, queries, vector search |
| `src/app/recall/unified.ts` | Mode routing, episode + entry result merging |
| `src/app/episode-ingest/` | Episode ingest service (CLI pipeline orchestration) |

The core episode code has zero infrastructure dependencies. The OpenClaw adapter handles transcript parsing, session registry lookups, and LLM calls through OpenClaw's embedded agent runner.
