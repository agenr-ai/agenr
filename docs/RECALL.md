# Recall

`agenr recall <query>` is a live CLI command backed by the v1 hybrid recall pipeline.

It embeds the query, retrieves candidates through both vector search and SQLite FTS, scores them in core, hydrates full entries, and records recall telemetry.

This document describes the code as it exists now, not just the intended flow.

Since `1.3.0`, there is also a unified agent-facing recall layer on top of the entry pipeline documented here. The standalone CLI in `src/cli/commands/recall.ts` still exposes the entry-recall surface shown below, while `src/app/recall/unified.ts` plus the OpenClaw `agenr_recall` tool add mode routing and episodic recall.

## Code map

- `src/cli/commands/recall.ts` - CLI option parsing, adapter wiring, and result formatting.
- `src/app/recall/unified.ts` - mode routing, unified result shaping, and orchestration between entry recall and episode recall.
- `src/app/recall/types.ts` - agent-facing mode, routing, time-window, and split-result response types.
- `src/core/recall/search.ts` - top-level recall pipeline orchestration.
- `src/core/recall/scoring.ts` - vector, lexical, recency, importance, and final-score math.
- `src/core/recall/lexical.ts` - tokenization, lexical search-plan generation, and lexical overlap scoring.
- `src/core/recall/temporal.ts` - explicit and inferred date parsing for temporal recall.
- `src/core/recall/types.ts` - recall input, output, candidate, and filter types.
- `src/core/episode/search.ts` - temporal, semantic, and hybrid episode retrieval modes.
- `src/core/episode/scoring.ts` - interval overlap scoring and temporal tie-break math for episodes.
- `src/core/episode/temporal-window.ts` - calendar-aware time-phrase parsing for episodic recall.
- `src/core/episode/types.ts` - episode query/result and temporal window types.
- `src/core/ports.ts` - `RecallPorts` plus episode database interfaces used by the pure core pipelines.
- `src/adapters/db/recall-adapter.ts` - libSQL implementation of vector search, FTS search, hydration, and recall-event recording.
- `src/adapters/db/episode-queries.ts` - SQL overlap lookup and episode vector search.
- `src/adapters/db/queries.ts` - `recordRecallEvent()` write path that updates counters and inserts `recall_events` rows.
- `tests/cli/commands/recall.test.ts` and `src/core/recall/search.integration.test.ts` - CLI surface, end-to-end pipeline, filter, telemetry, and concurrency coverage.
- `tests/core/episode/temporal-window.test.ts` and `tests/adapters/openclaw/tools.test.ts` - parser coverage, routing, split-result formatting, and episode recall behavior.

## Important architectural nuance

Recall is split cleanly between core and adapter concerns:

- `src/core/recall/` owns query parsing, candidate merge, scoring, thresholding, token budgeting, and final ranking.
- `src/adapters/db/recall-adapter.ts` owns retrieval, SQL-pushable filters, full-entry hydration, and telemetry writes.

That split means the current recall implementation is already adapter-shaped:

- the CLI wires a libSQL adapter today
- the core pipeline itself stays stateless
- there is no direct `DatabasePort` dependency in `src/core/recall/search.ts`

Two current-runtime details matter:

- vector search is not optional - if the vector query fails, recall throws instead of degrading to FTS-only
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

## Unified routing and episodic recall (1.3.0)

This section covers the newer unified recall layer used by `runUnifiedRecall()` and the OpenClaw `agenr_recall` tool. It sits above the entry-only CLI flow documented later and decides whether to query semantic entries, episodic memory, or both.

### Mode parameter

The unified layer accepts three modes:

- `auto` - default routing. The query text is classified and routed to entries, episodes, or both.
- `entries` - force semantic entry recall only. This is the right mode for exact facts, decisions, thresholds, versions, and preferences.
- `episodes` - force episodic recall only. With a resolved time window this becomes temporal episode search; without a time window it falls back to pure semantic episode search when embeddings are available.

`mode` is currently implemented in the unified app/tool layer, not in `src/cli/commands/recall.ts` yet.

### Auto-routing rules

`routeRecall()` uses a simple three-band router:

- **temporal narrative -> episodes**
- **factual -> entries**
- **mixed -> both**

Current detection is deliberately heuristic, not LLM-based:

- factual phrases are matched with regexes like `when did`, `when was`, `what decision`, `what preference`, `what's the default`, `which version`, and `what threshold`
- narrative phrases are matched with regexes like `what happened`, `what were we doing`, `what was going on`, `summarize`, and `catch me up`
- a **topic anchor** is detected when the query includes entry-only filters or wording like `about`, `regarding`, `with`, or `on <token>`
- a **supported time expression** comes from `parseTemporalWindow()`

That yields these concrete routing behaviors:

- factual + no supported time window -> `entries`
- factual + supported time window -> `entries` and `episodes`
- narrative + supported time window + no topic anchor -> `episodes`
- narrative + supported time window + topic anchor -> `episodes` and `entries`
- supported time window + topic anchor, even without an obvious narrative phrase -> `episodes` and `entries`
- supported time window without a clear narrative ask or topic anchor -> `entries`

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
- optional `timeWindow` - resolved start/end/timezone/resolvedFrom metadata
- `episodes` - episode matches
- `entries` - semantic entry matches
- `notices` - fallback and scope notes
- `count` - total across both sections

The OpenClaw formatter preserves that separation in text output:

- `Recall Route` first
- then optional `Resolved Time Window`
- then `Episode Matches`
- then `Entry Matches`
- then optional `Notices`

This is why mixed recall responses show sessions and durable knowledge side by side without pretending they are the same kind of memory.

One important caveat: `threshold`, `types`, and `tags` still apply to **entries only** in the current unified layer. When episodes are also queried, unified recall adds a notice saying so.

### Examples

Today, the implemented `mode` surface is the OpenClaw `agenr_recall` tool plus `runUnifiedRecall()`. The standalone CLI has not been wired to `mode` yet, but the intended CLI-shaped examples are:

```bash
agenr recall --mode episodes "what happened yesterday"
agenr recall --mode auto "what happened on agenr 2026-03-29"
agenr recall --mode entries "what decision set the schema threshold"
```

The equivalent tool-layer calls today are:

```txt
agenr_recall({ query: "what happened yesterday", mode: "episodes" })
agenr_recall({ query: "what happened on agenr 2026-03-29", mode: "auto", tags: ["agenr"] })
agenr_recall({ query: "what decision set the schema threshold", mode: "entries" })
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

That thrown error aborts the whole recall command. There is no current FTS-only fallback mode.

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

- hydration re-reads only active entries
- missing hydrated rows are silently dropped
- final ordering follows the ranked candidate list, not SQL return order

Each returned result contains:

- the full `Entry`
- the final `score`
- the score breakdown object

## 9. CLI formatting

The CLI prints each result as a multi-line block:

- `[<score>] <subject>`
- truncated content preview
- `type`, `importance`, `expiry`, and created date

In verbose mode it also prints:

- `vector`
- `lexical`
- `recency`
- `importance`
- `relevance`

Current formatting details:

- score is shown with two decimals
- content is truncated to `120` chars normally or `200` in verbose mode
- created dates are displayed as `YYYY-MM-DD`
- tags, source-file metadata, and recall counters are not shown

## 10. Recall telemetry

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
- `src/core/recall/types.ts`
- `src/core/episode/search.ts`
- `src/core/episode/scoring.ts`
- `src/core/episode/temporal-window.ts`
- `src/core/episode/types.ts`
- `src/core/ports.ts`
- `src/adapters/db/recall-adapter.ts`
- `src/adapters/db/episode-queries.ts`
- `src/adapters/db/queries.ts`
- `tests/cli/commands/recall.test.ts`
- `src/core/recall/search.integration.test.ts`
- `tests/core/episode/temporal-window.test.ts`
- `tests/adapters/openclaw/tools.test.ts`
