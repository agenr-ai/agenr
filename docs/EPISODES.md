# Episodes

Episodes are agenr's historical memory layer. Durable entries capture distilled knowledge that should stay true across sessions. Episodes capture what happened during a completed session as a narrative summary tied to a real time range.

That split lets the system answer questions like "what happened yesterday?", "what were we doing last week?", or "what was the previous deployment approach?" without flattening every session recap into permanent semantic memory.

Current production behavior covers OpenClaw and Skeln sessions:

- the OpenClaw plugin writes just-finished session episodes on `session_end`
- the Skeln plugin can write bounded shutdown episodes when `sessionTreeLineage` is enabled and activity thresholds pass
- the `agenr ingest episodes` CLI backfills or regenerates episodes from OpenClaw transcript files
- unified recall can query episodes directly or alongside durable entries

## Episodes vs Entries

| Dimension   | Entries                                                                  | Episodes                                                                          |
| ----------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Granularity | Atomic facts, decisions, preferences, lessons, relationships, milestones | One narrative summary for one completed session                                   |
| Authority   | Canonical durable memory                                                 | Historical context only                                                           |
| Lifecycle   | May be updated, superseded, or staled via `valid_to`                     | May be regenerated, updated, superseded, or staled via `validTo`                  |
| Retrieval   | Semantic similarity, lexical FTS, importance and recency shaping         | Temporal overlap, semantic vector search, or hybrid temporal + semantic reranking |
| Source      | LLM extraction from transcripts and other inputs                         | LLM summary generation from normalized session transcripts                        |
| Storage     | `entries` plus `durables_fts`                                            | `episodes`                                                                        |

Authority note: episode summaries are not transcripts, logs, or exact records. They are useful historical compression. When exact wording, exact counts, or exact timestamps matter, confirm against the source transcript or live state.

Freshness note: episode recall currently carries an explicit notice that episodes cover consolidated prior sessions only. The most recent completed session may not appear yet.

## Episode Record Shape

The stored `Episode` shape in `src/core/types.ts` includes:

- identity and provenance: `id`, `source`, `sourceId`, `sourceRef`, `transcriptHash`, `summaryHash`
- session metadata: `agentId`, `surface`, `startedAt`, `endedAt`, `messageCount`
- summary payload: `summary`, `tags`, `activityLevel`, optional `project`
- generation metadata: `genModel`, `genVersion`
- retrieval fields: optional `embedding`
- lifecycle fields: `validFrom`, `validTo`, `supersessionKind`, `supersessionReason`, `supersededBy`, `createdAt`, `updatedAt`

The schema supports episode sources `openclaw`, `skeln`, `codex`, `cli`, and `synthesis`. OpenClaw session ingest writes `source: "openclaw"` and Skeln shutdown ingest writes `source: "skeln"`.

Episode writes are idempotent:

- primary identity is `(source, source_id)` when a stable session id exists
- fallback identity is `(source, transcript_hash)` when it does not
- normalized payload hashing drives `inserted`, `updated`, or `unchanged` write outcomes

Episode recall and embedding backfill operate on active episodes only, meaning rows whose `validTo` window is still open and that are not superseded.

## How Episodes Are Generated

Episodes are generated through three current paths.

### 1. Automatic session-end write (OpenClaw)

When OpenClaw emits `session_end`, the plugin awaits bounded episode capture for the just-finished session through the shared `app/episode-ingest` workflow. This is separate from session-memory lineage intake, which is routed on `session_start`, compaction, reset, and shutdown-style session-end reasons.

When OpenClaw emits `before_compaction`, the plugin may also write a pre-compaction episode from the full transcript snapshot before OpenClaw compacts it. This path uses source id `${sessionId}:pre-compaction:${messageCount}`, is gated by `memoryPolicy.episodes.enabled` (not `memoryPolicy.sessionStart.enabled`), and runs under the shared episode-write guard.

OpenClaw session-end episode writes use the same phase 4 activity thresholds as Skeln shutdown episodes:

- at least 4 material user or assistant turns, or
- at least 10 minutes of session duration

Session-end capture is skipped when `reason` is `compaction` because the pre-compaction hook already captured the full transcript snapshot.

On OpenClaw `session_start`, agenr records lineage facts through `routeSessionMemoryTrigger`. When the host supplies `resumedFrom`, that value is stored as the predecessor source ref for resume lineage.

Important current behavior:

- predecessor continuity lookup and predecessor episode writes at first `before_prompt_build` are not wired in the current OpenClaw adapter
- session-end episode writes run after session-memory shutdown/tree triggers are routed

### 2. Skeln shutdown write

When the Skeln adapter receives `session_shutdown`, it first routes the lifecycle event through session-memory intake. If a session working set exists, agenr records a `merge_checkpoint` update and then closes that session set without requesting a goal-close episode. Explicit goal working sets are not closed by shutdown.

After the checkpoint attempt, the adapter may write a Skeln episode through the same shared `app/episode-ingest` workflow used by OpenClaw and CLI ingest. Automatic Skeln episode writes (shutdown and pre-compaction) are gated by `memoryPolicy.episodes.enabled` (default on), use Skeln JSONL parsing, and write `source: "skeln"`.

When Skeln emits `session_before_compact`, the adapter may also write a pre-compaction episode from the live transcript snapshot before compaction runs. This path uses source id `${sessionId}:pre-compaction:${messageCount}` and does not apply the shutdown activity thresholds.

The shutdown writer is bounded and conservative:

- it skips sessions below both phase 4 thresholds: fewer than 4 material user or assistant turns and under 10 minutes
- it skips active-session checks because Skeln has already emitted shutdown
- it uses the configured agenr episode model and credentials
- it applies a 45 second write timeout
- it embeds the summary only when embeddings are available and enough timeout budget remains
- it logs skipped, invalid, failed, timed-out, written, updated, or unchanged outcomes

### 3. CLI backfill and regeneration

The CLI repair and backfill path is:

```bash
agenr ingest episodes ~/.openclaw/agents/main/sessions/
```

Useful current flags:

```bash
agenr ingest episodes <path> --dry-run
agenr ingest episodes <path> --recent 30d
agenr ingest episodes <path> --regenerate
agenr ingest episodes <path> --no-embed
agenr ingest episodes --embed-only
agenr ingest episodes <path> --model openai/gpt-5.4-mini
agenr ingest episodes <path> --concurrency 12
```

This is the canonical repair path after a database reset, after plugin downtime, or when you want to regenerate summaries with current code.

## Episode Ingest Pipeline

The shared app workflow under `src/app/episode-ingest/` has four practical stages.

### 1. Discovery

Transcript discovery accepts either a single file or a directory tree. The OpenClaw adapter matches:

- normal session files: `<uuid>.jsonl`
- rotated reset files: `<uuid>.jsonl.reset.*`
- rotated deleted files: `<uuid>.jsonl.deleted.*`

### 2. Preflight classification

Each transcript is parsed and classified in parallel before any LLM calls happen.

Current skip rules:

- `skipped_exists` - an episode already exists and `--regenerate` was not requested
- `skipped_short` - fewer than `MIN_EPISODE_MESSAGES` cleaned messages are left after transcript normalization; this is currently `4`
- `skipped_active` - the session still looks active because `endedAt` is within the 5 minute active-session window
- `invalid` - there is no stable session id and no cleaned messages

Current transcript preparation behavior:

- empty messages are dropped before counting
- rendered transcript text uses stable `User:` and `Assistant:` prefixes
- transcript text is capped at `MAX_EPISODE_TRANSCRIPT_CHARS`, currently `14_000`
- when capping is required, the renderer preserves the beginning and end and omits the middle

### 3. Planning

The plan step can optionally apply `--recent`, which accepts relative shorthand like `30d` or an ISO timestamp. Candidates older than the cutoff are excluded before summary generation starts.

The plan also estimates:

- input tokens
- output tokens
- model cost

### 4. Execution

Execution runs summary generation concurrently, but database writes are serialized for stable upserts.

For each candidate:

- `generateEpisodeSummary()` asks the summary model for strict JSON
- the response is parsed into `summary`, `tags`, `activityLevel`, and optional `project`
- an embedding is generated when enabled and available
- the row is upserted into `episodes`

## Summary Content

The current summary prompt in `src/core/episode/summary-prompt.ts` asks for exactly one JSON object:

- `summary: string`
- `tags: string[]`
- `activityLevel: "substantial" | "minimal" | "none"`
- `project: string | null`

Current prompt requirements:

- summary should be 100 to 300 words
- it should describe what was discussed, decided, or accomplished
- it should preserve concrete specifics worth historical recall
- tags are lowercase anchors drawn from the transcript
- project is omitted when there is no clear project scope

## Session Metadata Resolution

Episode ingest prefers registry-backed metadata when it can get it, then falls back to transcript reconstruction.

### `sessions.json` registry

`loadOpenClawSessionRegistry()` reads `sessions.json` and provides:

- stable session id
- source reference
- agent id
- surface
- provider
- chat type

Registry metadata is marked as `metadataSource: "registry"`.

The underlying `sessions.json` reader is intentionally best-effort:

- missing, malformed, unreadable, or structurally invalid files are treated as an empty registry
- episode ingest then falls back to transcript reconstruction instead of failing the whole pass
- OpenClaw plugin continuity code logs those diagnostics but does not block prompt building on them

### Transcript reconstruction fallback

When registry metadata is missing, the transcript parser reconstructs what it can from:

- `inbound_meta`
- sender metadata blocks
- conversation info blocks
- path-derived agent identity
- content heuristics in the first user message

Current reconstructed surfaces include values such as `telegram`, `signal`, `tui`, `subagent`, and `heartbeat` when the parser can infer them.

## Episode Recall

Unified recall lives in `src/app/recall/unified.ts`. Public mode options are:

- `auto`
- `entries`
- `episodes`

Results are returned as separate `entries` and `episodes` arrays. The system does not merge them into one global ranked list.

### Current intent buckets

Auto mode now distinguishes four intent families:

- `factual`
- `temporal_narrative`
- `mixed`
- `historical_state`

`historical_state` is important current behavior. Queries like "what was the previous deployment approach", "what changed", or "what workflow did we use before" route to both entries and episodes even without a time phrase.

When `historical_state` is detected:

- durable recall receives `rankingProfile: "historical_state"`
- semantic episode search is allowed even without a resolved time window
- OpenClaw tool output renders entries before episodes

### Current routing rules

| Situation                                            | Queried                                                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `mode=durables`                                      | entries only                                                                                                           |
| `mode=episodes` with time window                     | episodes only                                                                                                          |
| `mode=episodes` without time window                  | episodes only, using semantic search when embeddings are available and otherwise returning no semantic episode matches |
| historical-state query                               | entries and episodes                                                                                                   |
| factual query with time window                       | entries and episodes                                                                                                   |
| factual query without time window                    | entries only                                                                                                           |
| narrative query with time window and no topic anchor | episodes only                                                                                                          |
| narrative query with time window and topic anchor    | episodes and entries                                                                                                   |
| time window with topic anchor                        | episodes and entries                                                                                                   |
| no supported episode signal                          | entries only                                                                                                           |

Topic-anchor detection is intentionally simple. It currently treats `about`, `regarding`, `with`, `on <topic>`, or entry-only filters as signals that semantic episode search would help.

One important Phase 3 nuance: explicit `asOf` targeting is currently an entry-side contract. It sharpens current-vs-prior state resolution on durable entries, while episode recall stays oriented around time-window parsing or semantic episode matching. Episodes then act as nearby transition context rather than as the canonical authority for `asOf` truth.

## Temporal Window Parsing

Episode recall does not reuse the older entry `around` parsing. It has its own parser in `src/core/episode/temporal-window.ts`.

Supported expressions currently include:

- `today`
- `yesterday`
- `this week`
- `last week`
- `this month`
- `last month`
- `N days ago`, including small spelled-out forms like `two days ago`
- `N weeks ago`, including small spelled-out forms like `two weeks ago`
- `N months ago`, including small spelled-out forms like `two months ago`
- `in March`
- `March 15` or `March 15th`
- `last Friday`
- ISO dates like `2026-03-15`

Resolution behavior:

- dates are resolved in the system local timezone
- `today`, `this week`, and `this month` end at `now`
- `N weeks ago` and `N months ago` resolve to anchor windows with a default `+/- 3 day` radius
- named month and month-day parsing pick the most recent matching calendar period

## Episode Search Modes

`src/core/episode/search.ts` supports three real search modes.

### Pure temporal

Used when a time window exists but no query embedding exists.

Search flow:

- fetch overlapping active episodes with `listEpisodesByTimeWindow()`
- overfetch candidates using `limit * 5`, bounded to `25-100`
- rank in memory by temporal overlap

Temporal ranking uses:

- `overlapQuality` as the primary signal
- `midpointProximity` as the secondary signal
- `activity`
- `recency`

The final temporal score is currently:

```text
overlapQuality * 0.75
+ midpointProximity * 0.20
+ activity * 0.04
+ recency * 0.01
```

### Pure semantic

Used when no time window exists but a query embedding does.

Search flow:

- query `vector_top_k('idx_episodes_embedding', ...)`
- filter to active episodes
- compute cosine similarity
- rank by semantic similarity first, with temporal, activity, and recency used only as tie-breakers

### Hybrid

Used when both a time window and a query embedding exist.

Important current behavior: this is a hard temporal filter plus semantic reranking, not a global vector search with a soft time bias.

The pipeline:

- first fetches only overlapping episodes
- then scores those candidates by semantic similarity
- then uses temporal, activity, and recency as tie-breakers

## Embeddings

Episodes can store an optional 1024-dimension embedding vector. Pure temporal recall does not require embeddings. Semantic and hybrid episode search do.

Current behavior:

- write-time embedding is best-effort
- active episodes without embeddings can be repaired with `--embed-only`
- backfill uses the stored episode summary text, not the original transcript

Backfill command:

```bash
agenr ingest episodes --embed-only
```

## Recall Notices

Unified episode recall can currently add several user-facing notices:

- `Episodes cover consolidated prior sessions only; the most recent completed session may not appear yet.`
- `Semantic episode search unavailable - showing temporal results only.`
- `Semantic episode search unavailable - no semantic episode results could be returned.`
- `Threshold, type filters, and tag filters were applied to entries only.`

That last notice matters because `threshold`, `types`, and `tags` still apply only to durable recall in the unified layer.

## Architecture

Episode functionality is split cleanly across core, app, and adapter layers.

| Location                                            | Current responsibility                                                |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `src/core/episode/summary-prompt.ts`                | Summary output contract, prompt text, JSON parsing                    |
| `src/core/episode/summary-generator.ts`             | Pure summary-generation orchestration against an `LlmPort`            |
| `src/core/episode/transcript-render.ts`             | Clean transcript rendering and transcript capping constants           |
| `src/core/episode/temporal-window.ts`               | Natural-language temporal parsing and window resolution               |
| `src/core/episode/scoring.ts`                       | Temporal overlap math, activity score, recency score                  |
| `src/core/episode/search.ts`                        | Pure temporal, semantic, and hybrid episode retrieval                 |
| `src/app/episode-ingest/service/preflight.ts`       | Discovery preflight, eligibility checks, transcript preparation       |
| `src/app/episode-ingest/service/plan.ts`            | Recent-cutoff filtering and cost estimation                           |
| `src/app/episode-ingest/service/execute.ts`         | Summary execution, embedding, serialized upserts                      |
| `src/app/episode-ingest/service/backfill.ts`        | Embedding-only repair path                                            |
| `src/app/recall/unified.ts`                         | Unified routing between entries and episodes                          |
| `src/adapters/db/episode-queries.ts`                | Episode persistence, overlap lookup, vector search, embedding updates |
| `src/adapters/openclaw/transcript/parser.ts`        | OpenClaw transcript normalization and surface reconstruction          |
| `src/adapters/openclaw/session/session-registry.ts` | `sessions.json` metadata lookup                                       |
| `src/adapters/openclaw/episode/episode-writer.ts`   | Background predecessor-session episode generation at session start    |
| `src/cli/commands/ingest-episodes.ts`               | CLI wiring, flags, execution, and reporting                           |

The design intent is unchanged: core episode logic stays infrastructure-free, app code owns workflow orchestration, and OpenClaw-specific concerns remain in the adapter layer.
