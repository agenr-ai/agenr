# Recall

`agenr recall <query>` is a live CLI command backed by the hybrid recall pipeline.

It embeds the query when possible, retrieves candidates through vector search plus SQLite FTS, degrades to lexical-only entry recall when query embeddings or vector search fail at runtime, scores candidates in core, hydrates full entries, and records recall telemetry.

This document describes the code as it exists now, not just the intended flow.

The current codebase also layers a unified agent-facing recall surface plus two automatic OpenClaw prompt-time recall paths on top of the base entry pipeline documented here. The standalone CLI in `src/cli/commands/recall.ts` still exposes the entry-recall surface shown below, while `src/app/recall/unified.ts`, `src/app/procedures/recall/service.ts`, and the OpenClaw `agenr_recall` tool add procedural routing plus episodic recall. Separately, `src/adapters/openclaw/hooks/before-prompt-build.ts` now injects continuity context plus a bounded session-start durable-memory patch through `src/app/session-start/`, and can inject a bounded proactive turn-time patch through `src/app/before-turn/`, without calling the public recall tool directly.

## Code map

- `src/cli/commands/recall.ts` - CLI option parsing, adapter wiring, and result formatting.
- `src/app/recall/unified.ts` - mode routing, unified result shaping, and orchestration between entry, procedure, and episode recall.
- `src/app/procedures/recall/service.ts` - dedicated procedure retrieval and canonical procedure selection.
- `src/app/recall/types.ts` - agent-facing mode, routing, time-window, and split-result response types.
- `src/core/recall/search.ts` - top-level recall pipeline orchestration.
- `src/core/recall/scoring.ts` - vector, lexical, recency, importance, and final-score math.
- `src/core/recall/fusion.ts` - pure reciprocal rank fusion helper used as the primary relevance signal across entry, episode, and procedure recall.
- `src/core/recall/neighborhood.ts` - pure neighborhood-expansion request types, seeded-rerank helpers, and the domain lineage predicates used by entry, episode, and procedure recall.
- `src/core/recall/mmr.ts` - pure maximal-marginal-relevance helper used to diversify the final shortlist across entry, episode, and procedure recall.
- `src/core/recall/cross-encoder.ts` - pure cross-encoder rerank orchestration helper shared by entry, episode, and procedure recall.
- `src/adapters/cross-encoder/openai-cross-encoder.ts` - OpenAI-backed `CrossEncoderPort` implementation using a boolean-classifier prompt plus `logit_bias` and `top_logprobs`.
- `src/core/recall/lexical.ts` - tokenization, lexical search-plan generation, and lexical overlap scoring.
- `src/core/recall/temporal.ts` - explicit and inferred date parsing for temporal recall.
- `src/core/recall/trace.ts` - typed per-call execution summaries for observability and recall-eval instrumentation.
- `src/core/recall/types.ts` - recall input, output, candidate, and filter types.
- `src/core/episode/search.ts` - temporal, semantic, and hybrid episode retrieval modes.
- `src/core/episode/scoring.ts` - interval overlap scoring and temporal tie-break math for episodes.
- `src/core/episode/temporal-window.ts` - calendar-aware time-phrase parsing for episodic recall.
- `src/core/episode/types.ts` - episode query/result and temporal window types.
- `src/core/ports.ts` - `RecallPorts` plus episode database interfaces used by the pure core pipelines.
- `src/adapters/db/recall-adapter.ts` - libSQL implementation of vector search, FTS search, bounded entry neighborhood expansion, hydration, and recall-event recording.
- `src/adapters/db/episode-queries.ts` - SQL overlap lookup and episode vector search.
- `src/adapters/db/queries.ts` - `recordRecallEvent()` write path that updates counters and inserts `recall_events` rows.
- `src/adapters/openclaw/tools/recall.ts` - `agenr_recall` schema, unified recall execution, and structured tool result shaping.
- `src/adapters/openclaw/tools/shared.ts` - human-readable unified recall formatter used by the OpenClaw tool.
- `src/app/session-start/service.ts` - host-neutral session-start patch selection that merges always-on core memory with artifact-grounded durable recall.
- `src/app/session-start/types.ts` and `src/app/session-start/ports.ts` - structured session-start patch contract and feature-scoped dependency types.
- `src/app/before-turn/service.ts` - host-neutral before-turn patch selection that merges bounded durable recall with optional canonical procedure suggestion.
- `src/app/before-turn/types.ts` and `src/app/before-turn/ports.ts` - structured before-turn patch contract and feature-scoped dependency types.
- `src/adapters/openclaw/hooks/before-prompt-build.ts` - automatic session-start patch injection, proactive before-turn patch injection, continuity composition, and store-nudge gating.
- `src/adapters/openclaw/format/recall-format.ts` - prompt formatter for the automatic session-start patch path.
- `src/adapters/openclaw/format/before-turn-format.ts` - prompt formatter for the automatic before-turn patch path.
- `tests/cli/commands/recall.test.ts`, `tests/core/recall/search.integration.test.ts`, and `tests/app/recall/unified.test.ts` - CLI surface, end-to-end pipeline, unified routing, historical-state behavior, tracing, telemetry, and concurrency coverage.
- `tests/core/episode/temporal-window.test.ts` and `tests/adapters/openclaw/tools.test.ts` - parser coverage, tool schema, split-result formatting, and episode recall behavior.

## Important architectural nuance

Recall is split cleanly between core and adapter concerns:

- `src/core/recall/` owns query parsing, candidate merge, historical-state ranking, claim-key-aware result shaping, thresholding, token budgeting, tracing, and final ranking. It also owns neighborhood-expansion request shapes and the seeded-rerank helpers that run over ranked candidates.
- `src/adapters/db/recall-adapter.ts` owns retrieval, SQL-pushable filters, bounded entry neighborhood expansion, full-entry hydration, and telemetry writes.

That split means the current recall implementation is already adapter-shaped:

- the CLI wires a libSQL adapter today
- the core pipeline itself stays stateless
- there is no direct `DatabasePort` dependency in `src/core/recall/search.ts`

Four current-runtime details matter:

- runtime query-embedding failures and vector-search failures degrade entry recall into an explicitly labeled lexical path instead of aborting the whole call
- historical-state entry recall is still the same core pipeline, but it asks the adapter for a bounded sweep over supersession chains, claim-key siblings, and retired same-topic fallbacks through the optional `expandNeighborhood()` port
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

## Unified routing, procedures, and episodic recall

This section covers the unified recall layer used by `runUnifiedRecall()` and the OpenClaw `agenr_recall` tool. It sits above the entry-only CLI flow documented later and decides whether to query semantic entries, procedural memory, episodic memory, or a supported combination.

### Mode parameter

The unified layer accepts four modes:

- `auto` - default routing. The query text is classified and routed to entries, procedures, episodes, or a supported combination.
- `entries` - force semantic entry recall only. This is the right mode for exact facts, decisions, thresholds, versions, and preferences.
- `episodes` - force episodic recall only. With a resolved time window this becomes temporal episode search; without a time window it falls back to pure semantic episode search when embeddings are available.
- `procedures` - force procedural recall only. This bypasses auto routing and runs the dedicated procedure retrieval service directly.

`mode` is currently implemented in the unified app/tool layer, not in `src/cli/commands/recall.ts` yet.

### Auto-routing rules

`routeRecall()` uses a heuristic router across factual, procedural, historical-state, temporal-narrative, and mixed signals.

Current detection is deliberately heuristic, not LLM-based:

- historical-state phrases are matched with conservative composite cues like `what was the previous`, `what was the earlier`, `what did we use before`, `what changed`, `changed from`, `before we switched`, and `before we migrated`
- procedural phrases are matched with cues like `how do I`, `what steps`, `walk me through`, `step by step`, `checklist for`, `procedure for`, and `method for`
- factual phrases are matched with regexes like `when did`, `when was`, `what decision`, `what preference`, `what's the default`, `which version`, and `what threshold`
- narrative phrases are matched with regexes like `what happened`, `what were we doing`, `what was going on`, `summarize`, and `catch me up`
- a **topic anchor** is detected when the query includes entry-only filters or wording like `about`, `regarding`, `with`, or `on <token>`
- a **supported time expression** comes from `parseTemporalWindow()`

That yields these concrete routing behaviors:

- explicit `mode=procedures` -> `procedures`
- procedural + no supported time window or topic anchor -> `procedures`
- procedural + topic anchor -> `procedures` and `entries`
- procedural + supported time window -> `procedures` and `episodes`
- procedural + supported time window + topic anchor -> `procedures`, `episodes`, and `entries`
- historical-state + no supported time window -> `entries` and `episodes`
- historical-state + procedural -> `procedures`, `entries`, and `episodes`
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
- `mode=procedures` always queries procedures only

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
- `N days ago`, including small spelled-out forms like `two days ago`
- `N weeks ago`, including small spelled-out forms like `two weeks ago`
- `N months ago`, including small spelled-out forms like `two months ago`
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
3. **Hybrid** - resolved time window plus embedding. Uses a hard temporal filter first (`listEpisodesByTimeWindow()`), then fuses a temporal rank list and a semantic rank list through the shared `rrfFuse()` helper. The fused RRF score drives ordering; temporal, activity, and recency stay as tie-break signals. Episodes without embeddings only appear in the temporal channel so they still rank below embedded matches.

The important design point is that hybrid episode search is **not** a broad vector search with a soft time bias. It is:

- hard temporal filter first
- semantic rerank second

That means mixed queries like “what happened on agenr 2026-03-29” cannot pull in semantically relevant sessions from the wrong time period.

If the router wants semantic episode search but query embeddings are unavailable, unified recall adds a notice instead:

- with a time window: `Semantic episode search unavailable - showing temporal results only.`
- without a time window: `Semantic episode search unavailable - no semantic episode results could be returned.`

### How results are returned

Unified recall does **not** merge procedures, episodes, and entries into one ranked list. `UnifiedRecallResult` returns them separately:

- `routing` - requested mode, detected intent, queried backends, and routing reason
- optional `parsedTimeWindow` - the internal resolved temporal window object used by the app layer
- optional `timeWindow` - resolved start/end/timezone/resolvedFrom metadata
- optional `asOf` - explicit current-vs-prior reference point applied to entry recall
- optional `procedure` - one canonical procedure answer when the dedicated procedure service found a stable leader
- `procedureCandidates` - ranked procedure candidates preserved separately from entry and episode results
- `procedureNotices` - degraded-mode or lexical-only notices from the dedicated procedure retrieval path
- `episodes` - episode matches
- `entries` - semantic entry matches
- `claimTransitions` - compact read-side change summaries built from recalled claim families plus any nearby episode context
- `notices` - fallback and scope notes
- `count` - total across all returned sections

The OpenClaw formatter preserves that separation in text output:

- `Recall Route` first
- then optional `Resolved Time Window`
- then optional `As Of`
- then `Procedure Matches` whenever procedures were queried or procedure data was returned
- then claim-aware `Entry Matches` before `Episode Matches` when the detected intent is `historical_state`
- then optional `Claim Transitions`
- otherwise `Episode Matches` before `Entry Matches`
- then optional `Notices`

Entry matches now carry a lightweight claim-centric projection on top of the raw ranked rows:

- rows are grouped into claim families when `claim_key` is present
- each family carries a runtime slot policy of `exclusive` or `multivalued`
- each row is labeled as `current`, `historical`, or `superseded`
- trust surfaces include normalized claim lifecycle labels such as `trusted`, `tentative`, `unresolved`, `legacy`, and `no-key`
- freshness and provenance cues come from `created_at`, `valid_from`, `valid_to`, supersession metadata, and stored claim-support metadata
- explicit `asOf` resolution prefers `valid_from` / `valid_to`, then `claim_support_observed_at`, then `created_at`
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
4. call the app-layer `runSessionStart()` service with normalized predecessor artifacts and bounded policy hints
5. let that service merge up to `4` always-on core entries with up to `3` artifact-grounded durable recall candidates, capped to `5` durable items after dedupe
6. format the returned patch as visibly separate continuity and durable-memory prompt sections, with the durable-memory portion wrapped in an `agenr-memory-context` fence

Important boundaries:

- this path still depends on adapter-supplied predecessor artifacts rather than pretending Agenr can reconstruct continuity from DB state alone
- any non-core durable memory on this path must be artifact-grounded, not a blind global session-start search
- continuity summaries and recent-session snippets stay visibly separate from durable memory
- fenced prompt-time durable memory is background context, not user text, and later sanitizers strip that fenced block before building future recall queries
- duplicate session-start injections are blocked by in-memory tracker state
- procedure suggestion is still out of scope for this v1 session-start slice
- non-user follow-up turns may receive a separate store nudge, but that is not recall

## Automatic OpenClaw before-turn recall

The same `before_prompt_build` hook also has a second automatic path for later user-facing turns after session start.

Current behavior in `handleAgenrBeforePromptBuild()` is:

1. detect that the session-start tracker has already consumed the current session
2. skip non-user triggers such as `heartbeat`, `cron`, and `memory`
3. skip short/social turns and other low-signal turns before proactive recall runs
4. derive a bounded query from the current prompt plus a compact recent-turn window from `event.messages`
5. call the app-layer `runBeforeTurn()` service with that normalized turn input and bounded policy hints
6. let that service run stricter-threshold durable entry recall plus optional dedicated procedure recall
7. inject the result only when the service does not abstain, wrapping the injected recall block in an `agenr-memory-context` fence

Important boundaries:

- this path is a bounded proactive surfacing layer, not a replacement for the explicit `agenr_recall` tool
- durable memory uses the same shared entry recall engine described in this document
- proactive procedure suggestion reuses the dedicated procedure recall service and only surfaces a canonical leader
- before-turn recall now requires stronger factual, procedural, or task signal before it runs at all
- before-turn durable recall normally surfaces a single durable item and only expands when all surfaced items clear the recalibrated high-confidence score gate
- the high-confidence gate also controls whether continuation-style turns like "what should we do next?" retry with a compact contextual anchor when the bare current-turn query surfaces a borderline leader
- both behaviors share `DEFAULT_HIGH_CONFIDENCE_RECALL_THRESHOLD` in `src/app/before-turn/service.ts`; see the "Ranking policy tuning history" section below for the pre- and post-RRF values
- before-turn prompt sections stay visibly separate from session-start continuity and durable-memory sections
- when embeddings are unavailable, durable and procedure selection degrade to lexical-only ranking instead of failing the turn

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

- Unicode-aware lowercase normalization
- regex: `[\p{L}\p{N}][\p{L}\p{N}._-]*`
- minimum token length `2`
- English stop words removed
- reserved FTS operator words like `or`, `not`, and `near` removed from token tiers

Important consequence: accented and other non-ASCII word tokens now participate in the all-token and any-token lexical tiers instead of degrading immediately to exact-phrase-only fallback.

If the tokenized query is empty after stop-word removal, recall still runs the exact-phrase tier.

FTS tier failures are swallowed per tier and the adapter continues to the next tier.

BM25 rank anchors the ordered lexical channel that feeds reciprocal rank fusion. The raw lexical overlap score is still kept on the result as evidence-only, but the lexical rank is what influences the fused relevance signal.

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

The raw lexical score is now evidence-only. It still appears in the score breakdown for trace visibility but no longer feeds the composite relevance signal directly.

### Relevance score

Relevance is now driven by **reciprocal rank fusion** (RRF) over per-channel ordered candidate id lists. `mergeCandidates()` emits one list per retrieval channel (vector and FTS today, plus the historical predecessor expansion when `rankingProfile: "historical_state"` is active), and `rrfFuse()` in `src/core/recall/fusion.ts` combines them with the Cormack et al. default rank constant `k = 60`:

- each channel contributes `1 / (rankIndex + k)` to an id's raw score
- the fused map is normalized by the theoretical maximum so an id that is top-ranked in every supplied channel maps to `1.0`
- empty channels are ignored and do not count toward the normalizer
- duplicate ids inside a single channel are compacted so they contribute exactly once

`scoreCandidate()` consumes that precomputed `relevance` value directly. The raw vector similarity and raw lexical overlap still show up in the score breakdown as evidence-only signals but are no longer blended into the composite.

RRF has two tuning knobs on `RecallExecutionOptions.rankingPolicy`:

- `rankingPolicy.rrf = "disabled"` is a hard kill switch. When set, recall falls back to single-channel vector ordering (with a lexical fallback when the vector channel is empty) so evals can isolate fusion effects without stripping channels from the pipeline. The fallback still records a trace branch with `applied: false` and `channelCount: 0 or 1`.
- `rankingPolicy.rrfRankConstant` overrides the Cormack et al. constant. Larger values flatten the contribution of the top ranks across channels; smaller values sharpen them. The default is `60`.

Tracing gained a new `rrf` branch on `RecallExecutionTraceSummary` with `{ applied, channelCount, rankConstant, fusedCandidateCount, maxFusedScore }`. The branch is populated on every recall call so consumers can inspect channel counts even when fusion is disabled.

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

### MMR diversification

A shared maximal-marginal-relevance stage sits between the claim-key shaping stage and the threshold filter on the entry recall pipeline, and between RRF fusion and the final `slice(limit)` on the episode and procedure pipelines. The helper lives in `src/core/recall/mmr.ts` and is a pure one-shot variant of the classic MMR ordering.

Key design points:

- MMR never rederives relevance from the query embedding. Each pipeline passes its already-shaped composite score as the MMR `relevance` signal, which preserves RRF fusion, historical lineage boosts, claim-key trust and redundancy penalties, and any seeded-rerank lift.
- Candidates without embeddings are not run through the MMR similarity math. They are appended after the embedded candidates in their original relative order, so missing-embedding fallbacks degrade to pass-through rather than crashing.
- When the query vector is empty or fewer than two candidates have usable embeddings, MMR is skipped and the input order is returned unchanged. The trace records this as `applied: false`.
- Ties on the MMR score are broken in input order so the diversified list stays stable across runs.

Tuning knobs live on `RecallExecutionOptions.rankingPolicy`:

- `rankingPolicy.mmrLambda` is the lambda balance between relevance (`lambda`) and diversity (`1 - lambda`). The default is `0.7`, which keeps relevance dominant but gives the diversity penalty enough room to demote near duplicates. Values are clamped into `[0, 1]`.
- `rankingPolicy.mmr = "disabled"` is a hard kill switch for A/B evaluation. When set, MMR never runs for any surface regardless of intent.

Per-surface behavior:

- Entry recall runs MMR on every call unless the kill switch disables it.
- Episode recall runs MMR inside hybrid mode only, and only when the routed intent is `factual` or `mixed`. Narrative, procedural, temporal, and historical-state intents keep the temporal-first ordering untouched. Pure-temporal and pure-semantic episode modes skip MMR entirely.
- Procedure recall runs MMR after RRF and seeded rerank, regardless of intent, because revisions of the same `procedure_key` routinely share both recall text and embeddings.

Tracing gained a new `mmr` branch on `RecallExecutionTraceSummary` with `{ applied, lambda, droppedDuplicateCount, reorderedIds }`. `droppedDuplicateCount` counts candidates whose max pairwise similarity to another candidate is at or above `0.95` and whose MMR rank slid below their input rank. `reorderedIds` lists every candidate whose final position differs from the input order, empty when MMR was skipped.

### Cross-encoder rerank

A shared cross-encoder rerank stage sits after MMR diversification and before the threshold filter on entry recall, and between RRF fusion and the final `slice(limit)` on episode and procedure recall. The orchestration helper lives in `src/core/recall/cross-encoder.ts` and is pure: it only needs a `CrossEncoderPort` from `src/core/ports.ts` plus the caller's shortlist. The OpenAI adapter lives in `src/adapters/cross-encoder/openai-cross-encoder.ts` and runs a boolean-classifier chat completion (`"Respond with 'True' if PASSAGE is relevant to QUERY and 'False' otherwise"`) using `logit_bias` and `top_logprobs` to extract a normalized relevance score per passage, modeled on graphiti's `openai_reranker_client.py`.

Key design points:

- The rerank only touches the top-K shortlist. Candidates past the shortlist keep their input order and their prior composite score, so a slow or noisy reranker cannot drop a long tail of valid matches.
- The cross-encoder score is blended with the prior composite through a linear alpha: `alpha * crossEncoderScore + (1 - alpha) * priorScore`. This keeps earlier shaping (RRF fusion, historical lineage boosts, claim-key trust and redundancy penalties, seeded rerank, MMR) participating in the final ordering.
- The helper fails closed. Any thrown adapter error, malformed provider payload, empty shortlist, or empty query short-circuits into a pass-through and records a stable `degradedReason` on the trace branch (`not_configured`, `disabled`, `no_candidates`, or `provider_error`). A broken cross-encoder can never drop recall below its pre-rerank baseline.
- The OpenAI adapter caps concurrency (default 4), retries retryable statuses (408, 409, 425, 429, 5xx) with exponential backoff, and fails closed on non-retryable errors so recall stays usable even when the reranker is flaky.

Tuning knobs live on `RecallExecutionOptions.rankingPolicy`:

- `rankingPolicy.crossEncoder = "disabled"` is a hard kill switch for A/B evaluation. When set, the rerank never runs even if a port is wired.
- `rankingPolicy.crossEncoderTopK` overrides the top-K shortlist. Default is `10` for entries and episodes and `10` for procedures through the shared `DEFAULT_CROSS_ENCODER_TOP_K`.
- `rankingPolicy.crossEncoderAlpha` overrides the blend weight. Default is `0.6` through the shared `DEFAULT_CROSS_ENCODER_ALPHA`. Values are clamped into `[0, 1]`.

Per-surface behavior:

- Entry recall runs the rerank whenever `RecallPorts.crossEncoder` is wired and the policy leaves it enabled.
- Episode recall runs the rerank inside hybrid mode only, mirroring the MMR placement. Unified recall plumbs `EpisodeCrossEncoderOptions` through based on the wired port.
- Procedure recall runs the rerank after MMR on the full shortlist whenever unified recall wires `ProcedureCrossEncoderOptions`, since revisions of the same `procedure_key` often share embedding and lexical mass.

Tracing gained a new `crossEncoder` branch on `RecallExecutionTraceSummary` with `{ applied, k, alpha, latencyMs, rescoredIds, degradedReason? }`. `rescoredIds` lists candidates whose composite score was reshaped by the rerank, empty when the stage was skipped.

Model configuration uses the standard `ModelConfig` pattern through `config.crossEncoderModel` and resolves through `resolveModel(config, "cross_encoder")`. The adapter requires an OpenAI chat model with `logit_bias` and `top_logprobs` support. The stage default is `gpt-5.4-nano`, and the provider defaults to `"openai"` even when the global provider is `"openai-codex"`, since the adapter calls `https://api.openai.com/v1/chat/completions` directly. The API key is resolved through `resolveCrossEncoderApiKey(config)` which prefers `config.credentials.openaiApiKey` and falls back to `OPENAI_API_KEY`.

### Neighborhood expansion and seeded rerank

Entry, episode, and procedure recall now share a generalized post-retrieval stage inspired by a layered ranking pipeline. The helpers live in `src/core/recall/neighborhood.ts`.

Two ideas matter:

1. **Bounded neighborhood expansion** is a typed sweep over lineage families the adapter can cheaply reach from SQL. Each expansion call passes a `families` list, a hard `budget`, and an `includeRetired` gate. The supported families are:
   - `supersession_chain` - direct `superseded_by` links in both directions
   - `claim_key_sibling` - rows sharing the same claim-key slot
   - `procedure_revision` - retired revisions of the same `procedure_key` (surfaced through the procedure recall path)
   - `session_family` - episodes from the same `source + sourceId` (or transcript hash fallback)
   - `topic_family` - retired-only fallback that reaches across strong shared subject prefixes for entries
2. **Seeded rerank** (`seededRerank()`) sits on top of the ranked candidate list. It picks a tight top-N leader group through `selectStrongSeeds()`, then adds a small positive delta to any candidate that shares structural or topical lineage with at least one strong seed. The rerank never lifts a candidate that has no lineage relationship to any seed, so it cannot pull in unrelated material.

Default-profile entry recall still filters retired and superseded rows out of the candidate pool and does not call the expansion port. It does run `seededRerank()` over the fused candidates so supersession-chain followers, claim-key siblings, and strong subject-prefix peers of the top leaders get a small coherence boost when they are already in the ranked pool.

The stage has one kill switch on `RecallExecutionOptions.rankingPolicy`:

- `rankingPolicy.neighborhood = "disabled"` skips both the adapter-scoped `expandNeighborhood()` call and the seeded-rerank pass so evals can isolate fusion and MMR effects from lineage-aware rerank. The trace branch still reports structured facts but records `expansionRequested: false` and empty `strongSeedIds` / `rerankBoostedIds` lists.

### Ranking policy (RRF, neighborhood, MMR, cross-encoder toggles)

The full ranking policy lives on `RecallExecutionOptions.rankingPolicy`. Every stage has an independent `"enabled" | "disabled"` toggle so evals can A/B one stage at a time without restating the rest of the policy. Numeric tuning knobs stay optional alongside the toggles. The policy fields are:

- `rrf` - reciprocal rank fusion toggle (default `"enabled"`)
- `rrfRankConstant` - RRF rank constant override (default `60`)
- `neighborhood` - neighborhood expansion plus seeded rerank toggle (default `"enabled"`)
- `mmr` - MMR diversification toggle (default `"enabled"`)
- `mmrLambda` - MMR relevance-diversity balance (default `0.7`, clamped into `[0, 1]`)
- `crossEncoder` - cross-encoder rerank toggle (default `"enabled"` when a port is wired)
- `crossEncoderTopK` - shortlist size override (default `10`)
- `crossEncoderAlpha` - cross-encoder blend weight (default `0.6`, clamped into `[0, 1]`)

Unified recall forwards the same policy object into entry, episode, and procedure recall, and maps the cross-encoder and MMR fields into the per-surface option bundles `EpisodeCrossEncoderOptions`, `EpisodeMmrOptions`, `ProcedureCrossEncoderOptions`, and `ProcedureMmrOptions`. This keeps one policy as the single source of truth for every surface that the unified orchestrator touches.

### Historical-state expansion and claim-key shaping

Entry recall has one important ranking variant: `rankingProfile: "historical_state"`.

Today that profile is set by unified recall when the router detects a prior-state question such as "what was the previous approach". The core pipeline then changes behavior in five ways:

1. it calls the adapter's `expandNeighborhood()` port with `families: ["supersession_chain", "claim_key_sibling", "topic_family"]` and `includeRetired: true` so retired predecessors, claim-key siblings, and retired same-topic fallbacks merge into the candidate pool
2. it flattens recency to a neutral `0.5` when there is no explicit `around` anchor
3. it applies additive lineage bonuses for likely prior-state matches
4. it applies light claim-key penalties to reduce redundant or low-trust current-state answers
5. it then runs `seededRerank()` with the historical weight so siblings and predecessors of strong historical-state leaders get a small coherence bump

`expandNeighborhood()` is adapter-scoped. The current libSQL adapter builds a single SQL union that prioritizes:

- direct `superseded_by` links first
- same `claim_key` lineage next, preferring trusted historical siblings
- retired same-subject rows as a weaker topic-family fallback

Historical bonuses are additive and clamp back into `0-1`. Each relation has a fixed floor that applies whenever the candidate is already outranking the active peer it is historically related to:

- direct predecessor of an active candidate: floor `+0.08`
- retired predecessor-like candidate: floor `+0.06`
- older same-slot or same-topic prior state: floor `+0.08`

When the active peer's composite dominates the predecessor's composite, the bonus is reshaped proportionally so the superseded entry edges the successor by `HISTORICAL_LINEAGE_GAP_MARGIN` (`0.02`). The result is capped at `HISTORICAL_LINEAGE_MAX_BONUS` (`0.45`) so claim-key shaping and MMR diversification still have room to operate after the boost lands. See the "Historical-state lineage bonus shaping" entry in "Ranking policy tuning history" below.

Claim-key trust also changes how lineage is interpreted:

- tentative same-slot lineage is suppressed when a trusted sibling for that slot exists
- active tentative current-state siblings in a slot with a trusted peer receive a `0.08` penalty
- extra trusted active siblings in the same slot receive a redundancy penalty of `0.05` per rank, capped at `0.15`

These shaping signals are returned in the final score breakdown and are now surfaced in the CLI verbose view plus the OpenClaw claim-centric entry formatter:

- `historicalLineage`
- `neighborhoodBoost`
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

- `relevance` - the fused RRF score used as the composite relevance signal
- `rrf` - alias of `relevance` that makes the RRF origin explicit in traces
- `vector` - evidence-only raw vector similarity
- `lexical` - evidence-only raw lexical overlap
- `recency`
- `importance`
- `historicalLineage`
- `neighborhoodBoost` - additive delta applied by the seeded rerank stage when the row shares lineage with a strong seed
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
- `neighborhoodBoost`
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
- `rrf` - whether reciprocal rank fusion actually ran, the active channel count, the effective rank constant, the number of fused candidates, and the maximum normalized fused score
- `neighborhood` - whether neighborhood expansion ran, the families requested, the expanded candidate count, the strong seed count, and the ids that received a seeded-rerank boost
- `mmr` - whether MMR ran, the effective lambda, the dropped-near-duplicate count, and the ids whose position changed relative to the input order
- `crossEncoder` - whether the cross-encoder rerank ran, the shortlist size `k`, the effective alpha, the rerank latency in milliseconds, the ids whose score was reshaped, and any stable `degradedReason` when the stage was skipped or failed closed
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

## Ranking policy tuning history

This section records before/after values for ranking-policy defaults that have been intentionally tuned after the graphiti-recall-borrows work landed. Every change cites the regression it targets so future tuning passes start from a documented state.

### `DEFAULT_HIGH_CONFIDENCE_RECALL_THRESHOLD` (before-turn)

- File: `src/app/before-turn/service.ts`
- Gates: `shouldRetryWeakPrimaryWithContext()` contextual-fallback retry, and the `selectDurablePatchItems()` expansion past the one-item cap.
- Before: `0.85` (tuned for the pre-RRF continuous relevance blend).
- Intermediate: `0.92` (initial phase-2 recalibration for the RRF-driven composite score distribution; insufficient for single-entry pools).
- After: `0.97` (phase-2 follow-up, tuned to keep single-candidate pools on the contextual-fallback side of the gate).
- Reason: reciprocal rank fusion in `src/core/recall/fusion.ts` normalizes rank-based contributions so a top-1 candidate in a single channel already lands at `1.0` after normalization, and a single-candidate pool lands at exactly `1.0`. With `score = 0.5 * relevance + 0.25 * recency + 0.25 * importance`, moderately important and reasonably recent single-channel leaders already composed above the old `0.85` gate, which suppressed the contextual-fallback retry on continuation-style turns like "what should we do next?" and over-expanded the durable patch past the normal one-item cap. The first phase-2 recalibration to `0.92` handled most single-channel leader cases, but the single-entry pools seeded by rows 22 and 23 of the phase-0 attribution sweep still composed to `~0.933` and stayed above `0.92`. The `0.97` gate keeps the high-confidence behavior gated on candidates that behave like top-1 in both retrieval channels with near-maximum recency and importance, and lets the single-candidate continuation-style cases escalate to the contextual fallback they were designed for. The precision floor for the new gate is the importance-10 very-recent permanent entry (composite `~0.999`), which still clears `0.97`.
- Regressions targeted: the `contextual-follow-up.fallback.inject` cases in both `before-turn-section-4-ablations` and `before-turn-section-5-ablations` (rows 22 and 23 in the phase-0 attribution sweep at run `2026-04-19T23-07-52-044Z`) as tracked in `docs/internal/recall/regression-attribution.md`.
- Phase: phase 2 (initial `0.92` recalibration) plus phase-2 follow-up (`0.97` single-pool guard) of the recall-regression-resolution plan.
- Regression tests: `tests/app/before-turn/service.test.ts` pins the recalibrated default on all three sides of the gate:
  - "retries with contextual fallback when the primary score clears the old 0.85 gate but not the recalibrated default" - moderate single-leader case (~0.890) stays below both `0.92` and `0.97`.
  - "retries with contextual fallback when a single-entry pool inflates the primary score past 0.92 but not 0.97" - single-entry pool case (~0.933, rows 22/23) clears `0.92` but must stay below `0.97`.
  - "keeps the current-turn-only variant when the primary score clears the recalibrated default" - precision floor (~0.999) clears `0.97`.
- Not changed in the same pass: `DEFAULT_RECALL_THRESHOLD = 0.6` and `DEFAULT_PROCEDURE_THRESHOLD = 0.72`. Neither was implicated in the threshold-induced regressions, and moving them without attribution evidence would risk widening or narrowing the before-turn surface in ways the regression table does not authorize.

### Historical-state lineage bonus shaping

- File: `src/core/recall/search.ts` (`applyHistoricalLineageBoosts`, `resolveHistoricalLineageBonus`, `shapeHistoricalLineageBonus`).
- Gates: the additive score delta applied on the `rankingProfile: "historical_state"` branch of entry recall. The bonus is layered on top of the base composite score alongside claim-key shaping and seeded rerank, and it feeds MMR diversification as the shaped relevance signal.
- Before: fixed additive deltas (`+0.08` for direct predecessor, `+0.06` for retired predecessor-like peer, `+0.08` for older same-slot or same-topic peer). A constant delta could not flip a predecessor whose RRF-compressed relevance lagged the current-state peer's relevance by more than the delta itself.
- After: a proportional bonus computed from the score gap to the best-scoring active peer with a qualifying historical relation. The bonus is `max(fixedFloor, gap + HISTORICAL_LINEAGE_GAP_MARGIN)`, capped at `HISTORICAL_LINEAGE_MAX_BONUS`. `HISTORICAL_LINEAGE_GAP_MARGIN = 0.02` is the minimum margin by which the superseded predecessor must edge the active successor; `HISTORICAL_LINEAGE_MAX_BONUS = 0.45` is the hard cap that keeps the bonus from dominating the entire score surface.
- Reason: `rrfFuse()` normalizes rank-based contributions so a single-channel current-state leader routinely lands at a relevance of `1.0` while its superseded predecessor lands near `0.33-0.5`. With `score = 0.5 * relevance + 0.25 * recency + 0.25 * importance` the composite gap between the two peers is often `0.03-0.06`, which the old fixed `+0.08` delta could usually close but which the combined claim-key shaping plus MMR stage sometimes re-opened. The proportional bonus makes the flip decision a function of the observed gap rather than a static constant, so the predecessor wins whenever the `historical_state` profile is active regardless of how compressed the RRF distribution is. The floor preserves the previously validated delta when the predecessor already outranks the successor. The cap prevents a pathological active peer (extreme importance, pinned recency, single-channel dominance) from pushing the bonus close to `1.0` and hiding claim-key redundancy or trust suppression.
- Regressions targeted: rows 8, 9, and 21 of the phase-0 attribution sweep (`threshold_induced` historical-state / `.previous-state` / `.what-changed` cases). The `2026-04-20T17-59-45-467Z` sweep re-run confirms all three flip to `pass` at baseline. Rows 11, 14, 18, and 20 also benefit at the RRF layer, moving from `mmr_induced` to `combined` because `rrf=disabled` now rescues them as well; their remaining baseline failure is an MMR-reordering shape that phase 4 owns.
- Phase: phase 3 of the recall-regression-resolution plan.
- Regression tests: `tests/core/recall/search.test.ts` pins the new shape at three points:
  - "flips the superseded trusted predecessor above an RRF-dominant successor in historical_state" - constructs the rows 8/9/21 shape where the current-state peer has higher RRF relevance, and asserts `historicalLineage > 0.08` plus a final-score margin of at least `HISTORICAL_LINEAGE_GAP_MARGIN` over the successor.
  - "keeps the current entry first under the default profile even when the pool has a direct predecessor" - pins the non-leak guard so the proportional bonus cannot lift a predecessor on default-profile queries.
  - Existing `historical_state` fixtures in the same file continue to assert the previously validated fixed-delta floors (`+0.08` direct predecessor, `+0.06` retired predecessor-like, `+0.08` older state).
- Not changed in the same pass: `DEFAULT_SEEDED_RERANK_WEIGHT = 0.03` in `src/core/recall/neighborhood.ts`. The plan's phase-3 option 1 (raise the seeded-rerank weight for `historical_state`) was rejected because raising it globally would leak into the default profile, and per-profile seeded-rerank weights would need a second magic constant; the proportional lineage bonus keeps all shaping inside the historical-state branch.

Later phases of the same plan will extend this section as they land. Each entry should cite the regression rows it targets before changing a default.

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
  "crossEncoderModel": { "provider": "openai", "model": "gpt-5.4-nano" },
  "dbPath": "/absolute/path/to/knowledge.db"
}
```

Notes:

- embeddings use `credentials.openaiApiKey`, then `OPENAI_API_KEY`
- if extraction uses Anthropic auth or OpenAI subscription auth, embeddings still require an OpenAI API key
- `embeddingModel` falls back to `text-embedding-3-small`
- `crossEncoderModel` is optional and follows the same `ModelConfig` shape as other per-stage overrides; it defaults to `{ provider: "openai", model: "gpt-5.4-nano" }` through `resolveModel(config, "cross_encoder")` and falls back to the OpenAI API key in `credentials.openaiApiKey` or `OPENAI_API_KEY`
- `AGENR_DB_PATH` overrides `dbPath`
- `AGENR_CONFIG_PATH` overrides the config file location

## Good files to read before changing recall

- `src/cli/commands/recall.ts`
- `src/app/recall/unified.ts`
- `src/app/recall/types.ts`
- `src/app/session-start/service.ts`
- `src/app/session-start/types.ts`
- `src/app/before-turn/service.ts`
- `src/app/before-turn/types.ts`
- `src/core/recall/search.ts`
- `src/core/recall/scoring.ts`
- `src/core/recall/lexical.ts`
- `src/core/recall/neighborhood.ts`
- `src/core/recall/mmr.ts`
- `src/core/recall/cross-encoder.ts`
- `src/adapters/cross-encoder/openai-cross-encoder.ts`
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
