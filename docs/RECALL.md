# Recall

`agenr recall <query>` is a live CLI command backed by the v1 hybrid recall pipeline.

It embeds the query when possible, retrieves candidates through vector search plus SQLite FTS, degrades to lexical-only entry recall when query embeddings or vector search fail at runtime, scores candidates in core, hydrates full entries, and records recall telemetry.

This document describes the code as it exists now, not just the intended flow.

Current releases also layer a unified agent-facing recall surface and an automatic OpenClaw session-start recall path on top of the base entry pipeline documented here. The standalone CLI in `src/cli/commands/recall.ts` still exposes the entry-recall surface shown below, while `src/app/recall/unified.ts` plus the OpenClaw `agenr_recall` tool add mode routing and episodic recall. Separately, `src/adapters/openclaw/hooks/before-prompt-build.ts` injects continuity context plus core memory at session start without calling the public recall tool.

## Code map

- `src/cli/commands/recall.ts` - CLI option parsing, adapter wiring, and result formatting.
- `src/app/recall/unified.ts` - mode routing, unified result shaping, and orchestration between entry recall and episode recall.
- `src/app/recall/types.ts` - agent-facing mode, routing, time-window, and split-result response types.
- `src/core/recall/search.ts` - top-level recall pipeline orchestration.
- `src/core/recall/scoring.ts` - vector, lexical, recency, importance, and final-score math.
- `src/core/recall/lexical.ts` - tokenization, lexical search-plan generation, and lexical overlap scoring.
- `src/core/recall/temporal.ts` - explicit and inferred date parsing for temporal recall.
- `src/core/recall/trace.ts` - typed per-call execution summaries for observability and recall-eval instrumentation.
- `src/core/recall/types.ts` - recall input, output, candidate, and filter types.
- `src/core/episode/search.ts` - temporal, semantic, and hybrid episode retrieval modes.
- `src/core/episode/scoring.ts` - interval overlap scoring and temporal tie-break math for episodes.
- `src/core/episode/temporal-window.ts` - calendar-aware time-phrase parsing for episodic recall.
- `src/core/episode/types.ts` - episode query/result and temporal window types.
- `src/core/ports.ts` - `RecallPorts` plus episode database interfaces used by the pure core pipelines.
- `src/adapters/db/recall-adapter.ts` - libSQL implementation of vector search, FTS search, historical predecessor expansion, hydration, and recall-event recording.
- `src/adapters/db/episode-queries.ts` - SQL overlap lookup and episode vector search.
- `src/adapters/db/queries.ts` - `recordRecallEvent()` write path that updates counters and inserts `recall_events` rows.
- `src/adapters/openclaw/tools/recall.ts` - `agenr_recall` schema, unified recall execution, and structured tool result shaping.
- `src/adapters/openclaw/tools/shared.ts` - human-readable unified recall formatter used by the OpenClaw tool.
- `src/adapters/openclaw/hooks/before-prompt-build.ts` - automatic session-start recall injection, continuity composition, and store-nudge gating.
- `src/adapters/openclaw/format/recall-format.ts` - prompt formatter for the automatic session-start core-memory injection path.
- `tests/cli/commands/recall.test.ts`, `tests/core/recall/search.integration.test.ts`, and `tests/app/recall/unified.test.ts` - CLI surface, end-to-end pipeline, unified routing, historical-state behavior, tracing, telemetry, and concurrency coverage.
- `tests/core/episode/temporal-window.test.ts` and `tests/adapters/openclaw/tools.test.ts` - parser coverage, tool schema, split-result formatting, and episode recall behavior.

## Important architectural nuance

Recall is split cleanly between core and adapter concerns:

- `src/core/recall/` owns query parsing, candidate merge, historical-state ranking, claim-key-aware result shaping, thresholding, token budgeting, tracing, and final ranking.
- `src/adapters/db/recall-adapter.ts` owns retrieval, SQL-pushable filters, historical predecessor lookup, full-entry hydration, and telemetry writes.

That split means the current recall implementation is already adapter-shaped:

- the CLI wires a libSQL adapter today
- the core pipeline itself stays stateless
- there is no direct `DatabasePort` dependency in `src/core/recall/search.ts`

Four current-runtime details matter:

- runtime query-embedding failures and vector-search failures degrade entry recall into an explicitly labeled lexical path instead of aborting the whole call
- historical-state entry recall is still the same core pipeline, but it can ask the adapter for inactive predecessor candidates through the optional `fetchPredecessors()` port
- typed recall tracing is opt-in and no-op by default, so observability can be added without changing ranking behavior
- recall telemetry is awaited as part of `recall()`, but the adapter serializes the writes internally and swallows telemetry failures

## CLI surface

```bash
agenr recall <query> \
  [--limit <n>] \
  [--threshold <n>] \
  [--budget <n>] \
  [--types <types>] \
  [--tags <tags>] \
  [--since <date>] \
  [--until <date>] \
  [--around <date>] \
  [--around-radius <n>] \
  [--verbose]
```

- `--limit <n>` sets the max result count. Default: `10`.
- `--threshold <n>` drops scored results below the inclusive `0-1` cutoff. Default: `0`.
- `--budget <n>` applies an approximate token budget after scoring.
- `--types <types>` filters by comma-separated entry types validated against the supported entry-type list.
- `--tags <tags>` filters by comma-separated literal tag values.
- `--since <date>` keeps only entries whose `created_at` is on or after the parsed date.
- `--until <date>` keeps only entries whose `created_at` is on or before the parsed date.
- `--around <date>` switches recency scoring to a gaussian date-proximity model centered on the parsed anchor.
- `--around-radius <n>` sets the gaussian radius in days. Default: `14`.
- `--verbose` prints per-result score breakdowns.

Unlike ingest, recall currently has no `--dry-run` flag.

## Unified routing and episodic recall

This section covers the newer unified recall layer used by `runUnifiedRecall()` and the OpenClaw `agenr_recall` tool. It sits above the entry-only CLI flow documented later and decides whether to query semantic entries, episodic memory, or both.

### Mode parameter

The unified layer accepts three modes:

- `auto` - default routing. The query text is classified and routed to entries, episodes, or both.
- `entries` - force semantic entry recall only. This is the right mode for exact facts, decisions, thresholds, versions, and preferences.
- `episodes` - force episodic recall only. With a resolved time window this becomes temporal episode search; without a time window it falls back to pure semantic episode search when embeddings are available.

`mode` is currently implemented in the unified app/tool layer, not in `src/cli/commands/recall.ts` yet.

### Auto-routing rules

`routeRecall()` uses a simple four-band router:

- **historical state -> entries and episodes**
- **temporal narrative -> episodes**
- **factual -> entries**
- **mixed -> both**

Current detection is deliberately heuristic, not LLM-based:

- historical-state phrases are matched with conservative composite cues like `what was the previous`, `what was the earlier`, `what did we use before`, `what changed`, `changed from`, `before we switched`, and `before we migrated`
- factual phrases are matched with regexes like `when did`, `when was`, `what decision`, `what preference`, `what's the default`, `which version`, and `what threshold`
- narrative phrases are matched with regexes like `what happened`, `what were we doing`, `what was going on`, `summarize`, and `catch me up`
- a **topic anchor** is detected when the query includes entry-only filters or wording like `about`, `regarding`, `with`, or `on <token>`
- a **supported time expression** comes from `parseTemporalWindow()`

That yields these concrete routing behaviors:

- historical-state + no supported time window -> `entries` and `episodes`
- historical-state + supported time window -> `entries` and `episodes`
- factual + no supported time window -> `entries`
- factual + supported time window -> `entries` and `episodes`
- narrative + supported time window + no topic anchor -> `episodes`
- narrative + supported time window + topic anchor -> `episodes` and `entries`
- supported time window + topic anchor, even without an obvious narrative phrase -> `episodes` and `entries`
- supported time window without a clear narrative ask or topic anchor -> `entries`

Historical-state intent beats plain factual detection. If the query also contains a real time expression, the detected intent remains `historical_state` rather than collapsing to `mixed`.

Explicit overrides still win:

- `mode=entries` always queries entries only
- `mode=episodes` always queries episodes only

### Temporal window parser

Episode recall does not reuse the older entry-recall `around` inference. It has a separate calendar-aware parser in `src/core/episode/temporal-window.ts` that returns:

- the resolved `window`
- concrete `bounds.start` / `bounds.end`
- the runtime `timezone`
- `resolvedFrom`, which preserves the matched phrase for output/debugging

Supported phrases today include:

- `today`
- `yesterday`
- `this week` / `last week`
- `this month` / `last month`
- `N days ago`
- `N weeks ago`
- `N months ago`
- `in March` (and the other month names)
- `March 15th`, `March 15`, `on March 15`, and similar month-day forms
- `last Friday` and the other weekdays
- ISO dates like `2026-03-15`

A few behavior details matter:

- `today`, `this week`, and `this month` end at `now`, not the end of the full calendar period
- `yesterday`, `last week`, `last month`, month names, month-day forms, weekdays, and ISO dates resolve to closed calendar intervals
- `N days ago` resolves to that full prior local calendar day
- `N weeks ago` and `N months ago` resolve to anchor windows with a fixed `±3` day radius around the anchor date
- month-day queries resolve to the most recent matching calendar date, so `December 25` can land in the previous year
- month-day parsing wins over weekday parsing when both appear in the same query

### Episode recall pipeline

Pure temporal episode recall does not depend on embeddings. The flow in `searchEpisodes()` is:

1. parse the query into a `TemporalWindow`
2. materialize concrete bounds with `resolveTemporalWindowBounds()`
3. fetch overlap candidates through `listEpisodesByTimeWindow()`
4. score each candidate in memory with `scoreEpisodeMatch()`
5. sort with temporal-first ordering and return the top `limit`

The SQL overlap filter in `listEpisodesByTimeWindow()` is inclusive:

- `started_at <= query_end`
- `COALESCE(ended_at, started_at) >= query_start`

Only active episodes are considered (`retired = 0` and `superseded_by IS NULL`). Candidate lookup overfetches with `limit * 5`, bounded to `25-100`, before in-memory ranking.

`scoreEpisodeMatch()` ranks by interval overlap, not by semantic similarity. Its final score is:

```txt
score = overlapQuality * 0.75 + midpointProximity * 0.20 + activity * 0.04 + recency * 0.01
```

Where:

- `overlapQuality` is the primary signal: a harmonic-mean style blend of query coverage and episode precision
- `midpointProximity` is the secondary temporal tiebreaker
- `activity` lightly boosts more substantial sessions
- `recency` is only a very small final tiebreaker

Sort precedence for pure temporal recall is even stricter than the final score: overlap quality first, then midpoint proximity, then activity, then recency, then the stored final score.

### Hybrid semantic episode search

Episode search has three actual modes inside `src/core/episode/search.ts`:

1. **Pure temporal** - resolved time window, no embedding. Uses SQL overlap candidates plus `scoreEpisodeMatch()`.
2. **Pure semantic** - embedding, no time window. Uses `episodeVectorSearch()` and ranks by cosine similarity first.
3. **Hybrid** - resolved time window plus embedding. Uses a hard temporal filter first (`listEpisodesByTimeWindow()`), then reranks the overlapping candidates by semantic similarity with temporal/activity/recency as tie-break signals.

The important design point is that hybrid episode search is **not** a broad vector search with a soft time bias. It is:

- hard temporal filter first
- semantic rerank second

That means mixed queries like “what happened on agenr 2026-03-29” cannot pull in semantically relevant sessions from the wrong time period.

If the router wants semantic episode search but query embeddings are unavailable, unified recall adds a notice instead:

- with a time window: `Semantic episode search unavailable - showing temporal results only.`
- without a time window: `Semantic episode search unavailable - no semantic episode results could be returned.`

### How results are returned

Unified recall does **not** merge episodes and entries into one ranked list. `UnifiedRecallResult` returns them separately:

- `routing` - requested mode, detected intent, queried backends, and routing reason
- optional `parsedTimeWindow` - the internal resolved temporal window object used by the app layer
- optional `timeWindow` - resolved start/end/timezone/resolvedFrom metadata
- `episodes` - episode matches
- `entries` - semantic entry matches
- `notices` - fallback and scope notes
- `count` - total across both sections

The OpenClaw formatter preserves that separation in text output:

- `Recall Route` first
- then optional `Resolved Time Window`
- then claim-aware `Entry Matches` before `Episode Matches` when the detected intent is `historical_state`
- otherwise `Episode Matches` before `Entry Matches`
- then optional `Notices`

Entry matches now carry a lightweight claim-centric projection on top of the raw ranked rows:

- rows are grouped into claim families when `claim_key` is present
- each row is labeled as `current`, `historical`, or `superseded`
- trust surfaces include normalized claim lifecycle labels such as `trusted`, `tentative`, `unresolved`, `legacy`, and `no-key`
- freshness and provenance cues come from `created_at`, `valid_from`, `valid_to`, supersession metadata, and stored claim-support metadata
- a short `why_surfaced` explanation summarizes the score signals that pushed the row into the final answer

This is why mixed recall responses show sessions and durable knowledge side by side without pretending they are the same kind of memory.

One important caveat: `threshold`, `types`, and `tags` still apply to **entries only** in the current unified layer. When episodes are also queried, unified recall adds a notice saying so.

Another caveat: semantic entry recall still depends on embeddings. In mixed or auto routing, unified recall can skip the entry side and return a notice when embeddings are unavailable. In explicit `mode=entries`, the same condition throws instead of degrading silently.

## Automatic OpenClaw session-start recall

The OpenClaw plugin has a second recall-related path that runs automatically on the first `before_prompt_build` call for a session. It is separate from `agenr_recall`.

Current behavior in `handleAgenrBeforePromptBuild()` is:

1. consume the session-start tracker so the recall injection runs only once per session
2. resolve predecessor continuity and recent-session content through the OpenClaw continuity helpers
3. kick off a background predecessor-episode write when a predecessor session exists
4. fetch up to `4` core entries through `services.memory.listCoreEntries()`
5. format those core entries as an `## Agenr Session Recall` prompt section
6. prepend continuity summary, recent-session context, and core memory to the prompt in that order

Important boundaries:

- this path injects only always-on core memory from agenr itself, not general entry recall results
- continuity summaries and recent-session snippets stay visibly separate from durable memory
- duplicate session-start injections are blocked by in-memory tracker state
- non-user follow-up turns may receive a separate store nudge, but that is not recall

## Memory authority levels

Adapters and prompts should teach the model that recall surfaces do not all carry the same authority.

1. Durable entries are the canonical memory record. Use them for verified facts, standing decisions, preferences, lessons, and other durable knowledge. When live evidence contradicts an entry, update or retire it instead of quietly routing around it.
2. Episode recall is narrative historical context. Use it for questions about what happened in a past session or time window, but confirm exact wording, timestamps, counts, and other precision-sensitive details when they matter.
3. Session handoffs and continuity summaries are approximate restart context. They are useful for resuming open threads, but they can be incomplete, stale, or narrower than the full transcript history.
4. Live verification always wins. If a file, tool call, database query, or host check can answer the question directly, that fresh evidence should override stored memory.

Adapter guidance:

- Keep durable entries, episodes, and handoffs visibly separated in prompt formatting and result rendering.
- Do not blend narrative recall and durable facts into one undifferentiated block.
- Encourage focused recall queries that match the memory tier you need instead of broad fishing expeditions.
- Teach the model to verify precision-sensitive claims live when verification is cheap.

### Examples

Today, the implemented `mode` surface is the OpenClaw `agenr_recall` tool plus `runUnifiedRecall()`. The standalone CLI still does not accept `--mode`, so the live examples are:

```txt
agenr_recall({ query: "what happened yesterday", mode: "episodes" })
agenr_recall({ query: "what happened on agenr 2026-03-29", mode: "auto", tags: ["agenr"] })
agenr_recall({ query: "what was the previous deployment approach", mode: "auto" })
agenr_recall({ query: "what decision set the schema threshold", mode: "entries" })
```

Programmatic callers use the same routing layer through `runUnifiedRecall()`:

```ts
await runUnifiedRecall({ text: "what happened yesterday", mode: "episodes" }, deps);
```

## End-to-end flow

### 1. Config and adapter setup

The CLI does the following before running recall:

- loads config via `readConfig()`
- resolves the database path via `resolveDbPath()`
- resolves the embedding API key and model
- opens the database adapter
- creates the recall adapter with the database plus embedding client

Recall does not use the extraction model, dedup model, or any LLM adapter.

## 2. Input normalization

`recall()` immediately normalizes the raw input:

- empty or whitespace-only query text returns `[]`
- `limit` defaults to `10` and is normalized to a non-negative integer
- `threshold` is clamped into `0-1`
- `budget` becomes `null` when omitted or non-finite
- `sessionKey` is supported by the core API for telemetry attribution, but the CLI does not expose a flag for it

If the effective limit is `0`, recall returns `[]` without embedding or retrieval.

## 3. Temporal parsing and filter construction

Recall has two temporal concepts:

- `since` / `until` are hard SQL filters
- `around` is a scoring bias, not a filter

### `since` and `until`

`parseRelativeDate()` currently supports:

- ISO-like date strings accepted by `new Date(...)`
- relative day shorthand like `7d`

It does not support `7w` or `3m` shorthand.

If `since` or `until` cannot be parsed, the filter is silently ignored rather than treated as an error.

### `around`

If `--around` is set, recall parses that value first.

If `--around` is omitted, recall tries to infer a temporal anchor from the query text itself. Current supported phrases include:

- `yesterday`
- `last week`
- `last month`
- `last year`
- `this week`
- `this month`
- `<n> days ago`
- `<n> weeks ago`
- `<n> months ago`
- `in january` through `in december`

If inference would land in the future, the anchor is clamped back to "now".

### SQL-pushable filters

After date parsing, `buildEntryFilters()` composes the filter payload passed into both retrieval paths.

Current filter semantics are:

- `types` use an SQL `IN (...)` clause
- `tags` use exact JSON-array membership checks
- multiple tags are ANDed together, not ORed
- `since` and `until` are inclusive comparisons on `created_at`

Both retrieval paths also hard-filter for active entries only:

- `retired = 0`
- `superseded_by IS NULL`

## 4. Query embedding

Core recall calls `ports.embed(text)` once for the query string.

In the current CLI path, that means:

- OpenAI embeddings
- default model `text-embedding-3-small` unless config overrides it
- one query embedding per recall invocation

If the embedding provider returns an empty vector, vector search contributes no candidates.

## 5. Candidate retrieval

Recall runs vector and lexical retrieval in parallel.

### Vector retrieval

The vector path:

1. overfetches with `limit * 4`
2. uses `vector_top_k('idx_entries_embedding', vector32(?), ?)`
3. joins those row IDs back to `entries`
4. applies active/type/tag/date filters in SQL
5. recomputes cosine similarity in TypeScript from the stored embedding
6. drops non-positive similarities
7. sorts descending by similarity and slices back to the requested vector limit

Current behavior to know:

- if `limit <= 0`, it returns `[]`
- if the query embedding is empty, it returns `[]`
- if vector serialization fails, it returns `[]`
- if the libSQL vector query itself fails, the adapter throws `Vector search is unavailable: ...`

The core recall pipeline now treats query-embedding failure and vector-query failure as degraded-mode signals:

- embedding failure -> skip vector retrieval, keep lexical retrieval, label the call as lexical-only degraded mode
- vector query failure -> keep lexical retrieval, preserve explicit degraded notices, and continue scoring any lexical candidates
- CLI recall prints degraded notices
- unified recall and the OpenClaw `agenr_recall` tool surface the same notices through their `notices` output

### Lexical retrieval

The FTS path:

1. overfetches with `limit * 2`
2. builds a lexical plan from the query text
3. runs each tier in order until all tiers are attempted
4. keeps only the first hit for each entry ID
5. sorts by tier priority, then BM25 rank
6. slices back to the requested lexical limit

Current tiers are:

- `exact` - quoted phrase search on the raw trimmed query
- `all_tokens` - all normalized tokens must match
- `any_tokens` - any normalized token may match

Tokenization is deliberately simple:

- lowercase only
- regex: `[a-z0-9][a-z0-9._-]*`
- minimum token length `2`
- English stop words removed
- reserved FTS operator words like `or`, `not`, and `near` removed from token tiers

Important consequence: non-ASCII text degrades toward the exact-phrase tier because the tokenizer is ASCII-centric.

If the tokenized query is empty after stop-word removal, recall still runs the exact-phrase tier.

FTS tier failures are swallowed per tier and the adapter continues to the next tier.

BM25 rank is used only for admission ordering inside the lexical path. It is not part of the final recall score.

## 6. Candidate merge and scoring

After retrieval, recall merges vector and FTS candidates by entry ID.

Merge behavior:

- an entry can arrive from either or both paths
- vector similarity is preserved when available
- duplicate IDs are collapsed before scoring

Each merged candidate is then rescored in core using the live scoring model.

### Lexical score

`computeLexicalScore()` combines:

- token-overlap ratio against subject plus content
- phrase-match bonus for matching 2+ token sequences, capped at `0.4`
- exact subject-match bonus of `0.3`

### Relevance score

`combinedRelevance(vector, lexical)` behaves like this:

- if both signals are positive: `vector * 0.6 + lexical * 0.4`
- otherwise: `max(vector, lexical)`

### Recency score

Without an `around` anchor:

- `core` expiry always scores `1`
- `permanent` expiry uses a `365` day half-life
- `temporary` expiry uses a `30` day half-life

With an `around` anchor:

- recency becomes gaussian proximity to that date
- default radius is `14` days
- expiry tier no longer changes the recency formula for that query

### Importance score

Importance is normalized from the `1-10` domain into the `0.4-1.0` range.

### Final score

The final score is:

```txt
score = relevance * 0.5 + recency * 0.25 + importance * 0.25
```

All component scores and the final score are clamped into `0-1`.

### Historical-state expansion and claim-key shaping

Entry recall has one important ranking variant that the old v1-only docs did not cover: `rankingProfile: "historical_state"`.

Today that profile is set by unified recall when the router detects a prior-state question such as "what was the previous approach". The core pipeline then changes behavior in four ways:

1. it asks the adapter for inactive predecessor candidates through `fetchPredecessors()`
2. it flattens recency to a neutral `0.5` when there is no explicit `around` anchor
3. it applies additive lineage bonuses for likely prior-state matches
4. it applies light claim-key penalties to reduce redundant or low-trust current-state answers

`fetchPredecessors()` is adapter-scoped to the active candidate set. The current libSQL adapter expands by:

- direct `superseded_by` links first
- same `claim_key` lineage next, preferring trusted historical siblings
- retired same-subject rows as a weaker fallback

Historical bonuses are additive and clamp back into `0-1`:

- direct predecessor of an active candidate: `+0.08`
- retired predecessor-like candidate: `+0.06`
- older same-slot or same-topic prior state: `+0.08`

Claim-key trust also changes how lineage is interpreted:

- tentative same-slot lineage is suppressed when a trusted sibling for that slot exists
- active tentative current-state siblings in a slot with a trusted peer receive a `0.08` penalty
- extra trusted active siblings in the same slot receive a redundancy penalty of `0.05` per rank, capped at `0.15`

These shaping signals are returned in the final score breakdown and are now surfaced in the CLI verbose view plus the OpenClaw claim-centric entry formatter:

- `historicalLineage`
- `claimKeyTrustPenalty`
- `claimKeyRedundancyPenalty`

## 7. Thresholding, budgeting, and limit

After scoring:

1. weak vector-only candidates without meaningful raw evidence are dropped
2. results below `threshold` are dropped
3. the optional token budget is applied greedily in score order
4. the list is sliced to `limit`

### Threshold behavior

Thresholding happens after scoring, not during retrieval.

So vector and FTS still overfetch first, and only then does recall discard low-score candidates.

Recall also applies a raw-evidence gate before the score threshold is considered final:

- lexical support is always considered sufficient raw evidence
- vector-only candidates must clear a minimum raw vector similarity floor
- recency and importance cannot rescue weak vector-only drift into a returned result

### Budget behavior

The budget estimator is intentionally simple:

```txt
(entry.subject.length + entry.content.length) / 4
```

Budgeting has one important safeguard:

- the first threshold-qualified result is always kept, even if it alone exceeds the budget

After that, lower-ranked results are skipped whenever adding them would exceed the remaining budget.

## 8. Hydration and final output

The scoring pass only uses the minimal candidate shape.

Before returning, recall calls `hydrateEntries()` for the ranked IDs and rebuilds the final result list in ranked order.

Current hydration behavior:

- hydration re-reads the ranked IDs without filtering out inactive historical rows
- missing hydrated rows are silently dropped
- final ordering follows the ranked candidate list, not SQL return order

Each returned result contains:

- the full `Entry`
- the final `score`
- the score breakdown object

The current `scores` payload includes:

- `relevance`
- `vector`
- `lexical`
- `recency`
- `importance`
- `historicalLineage`
- `claimKeyTrustPenalty`
- `claimKeyRedundancyPenalty`

## 9. CLI formatting

The CLI prints each result as a multi-line block:

- `[<score>] <subject>`
- truncated content preview
- `type`, `importance`, `expiry`, created date, memory-state label, and claim-status label
- claim family and freshness summary
- optional provenance summary when the row has supersession or claim-support metadata
- one `why=...` line that summarizes why the row surfaced

In verbose mode it also prints:

- `vector`
- `lexical`
- `recency`
- `importance`
- `relevance`
- `historicalLineage`
- `claimKeyTrustPenalty`
- `claimKeyRedundancyPenalty`

Current formatting details:

- score is shown with two decimals
- content is truncated to `120` chars normally or `200` in verbose mode
- created dates are displayed as `YYYY-MM-DD`
- tags, source-file metadata, and recall counters are not shown

## 10. Recall tracing

`recall()` now supports an optional typed trace sink through `RecallExecutionOptions.trace`.

Important properties of the tracing path:

- tracing is observational only and defaults to `createNoopRecallTraceSink()`
- the trace summary is emitted exactly once per recall call
- tracing works for successful calls, no-result calls, and thrown errors
- integration tests explicitly assert that enabling tracing does not change result ordering or scores

The emitted `RecallExecutionTraceSummary` currently contains:

- `filtering` - active `types`, `tags`, `since`, `until`, and optional `around`
- `ranking` - normalized `limit`, `threshold`, `budget`, and optional stable `noResultReason`
- `candidateCounts` - merged, threshold-qualified, budget-accepted, final-ranked, and returned counts
- `claimKey` - historical boosts, tentative-lineage suppression, trust penalties, and redundancy penalties
- `degraded` - whether recall fell back away from the normal vector-backed path, the stable causes, whether the run was lexical-only, and the user-facing notices
- `timings` - merge, score, threshold, budget, and result-shaping timings

Stable no-result reasons today are:

- `empty_query`
- `limit_zero`
- `no_candidates`
- `below_threshold`
- `hydrate_missing`
- `degraded_no_candidates`
- `degraded_below_threshold`

This tracing surface is what the internal recall-eval seam and future observability hooks should consume. It is separate from user-facing recall telemetry.

## 11. Recall telemetry

If recall returns at least one result, it records telemetry for those entry IDs.

Current telemetry behavior:

1. update each entry's `recall_count`
2. update each entry's `last_recalled_at`
3. insert one row into `recall_events`

Each event stores:

- a generated event ID
- `entry_id`
- the raw query text
- optional `session_key`
- `recalled_at`

Two reliability details matter:

- `recall()` awaits `recordRecallEvents()` before returning
- the adapter serializes writes behind a `pendingWrites` promise chain so concurrent recalls do not all write at once

Telemetry failures do not fail recall:

- per-entry write errors are swallowed inside the adapter
- the core recall function also wraps the telemetry call in `.catch(() => undefined)`

So the user still gets results even when telemetry writes fail.

## Config relevant to recall

A minimal recall-relevant config looks like this:

```json
{
  "auth": "openai-api-key",
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "credentials": {
    "openaiApiKey": "<OpenAI API key>"
  },
  "embeddingModel": "text-embedding-3-small",
  "dbPath": "/absolute/path/to/knowledge.db"
}
```

Notes:

- embeddings use `credentials.openaiApiKey`, then `OPENAI_API_KEY`
- if extraction uses Anthropic auth or OpenAI subscription auth, embeddings still require an OpenAI API key
- `embeddingModel` falls back to `text-embedding-3-small`
- `AGENR_DB_PATH` overrides `dbPath`
- `AGENR_CONFIG_PATH` overrides the config file location

## Good files to read before changing recall

- `src/cli/commands/recall.ts`
- `src/app/recall/unified.ts`
- `src/app/recall/types.ts`
- `src/core/recall/search.ts`
- `src/core/recall/scoring.ts`
- `src/core/recall/lexical.ts`
- `src/core/recall/temporal.ts`
- `src/core/recall/trace.ts`
- `src/core/recall/types.ts`
- `src/core/episode/search.ts`
- `src/core/episode/scoring.ts`
- `src/core/episode/temporal-window.ts`
- `src/core/episode/types.ts`
- `src/core/ports.ts`
- `src/adapters/db/recall-adapter.ts`
- `src/adapters/db/episode-queries.ts`
- `src/adapters/db/queries.ts`
- `src/adapters/openclaw/tools/recall.ts`
- `src/adapters/openclaw/tools/shared.ts`
- `src/adapters/openclaw/hooks/before-prompt-build.ts`
- `src/adapters/openclaw/format/recall-format.ts`
- `tests/cli/commands/recall.test.ts`
- `tests/core/recall/search.integration.test.ts`
- `tests/app/recall/unified.test.ts`
- `tests/core/episode/temporal-window.test.ts`
- `tests/adapters/openclaw/tools.test.ts`
