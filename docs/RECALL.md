# Recall

Recall in `agenr` is a hybrid retrieval and ranking system for three memory surfaces:

- durable entries
- episodes
- procedures

The system is exposed through multiple callers:

- `agenr recall <query>` for entry recall at the CLI
- `runUnifiedRecall()` and host-plugin `agenr_recall` for routed entry, episode, and procedure recall
- automatic host prompt-time recall paths for session start and later user turns

This document explains how recall works today: the retrieval channels, ranking equations, routing concepts, tuning knobs, and the boundaries between durable memory, episodic context, and procedures.

## Design goals

Recall optimizes for a few core properties:

- hybrid retrieval, so strong lexical matches survive when embeddings are weak or unavailable
- bounded ranking, so scoring stays explainable and tunable
- clean separation of memory authorities, so durable facts, episodes, and procedures do not get blended into one undifferentiated result set
- graceful degradation, so vector, embedding, or rerank failures fall back to simpler recall rather than failing the whole call
- adapter isolation, so retrieval and persistence live in adapters while ranking and shaping stay in core

## Recall surfaces

### Entry recall

Entry recall is the durable-memory path. It is the right surface for:

- facts
- decisions
- preferences
- standing thresholds
- versions
- claim-key-shaped current or prior state

### Episode recall

Episode recall is the narrative history path. It is the right surface for:

- what happened in a time window
- what the system was doing around a date
- session-level historical context

### Procedure recall

Procedure recall is the procedural-memory path. It is the right surface for:

- how-to questions
- step-by-step workflows
- canonical operating procedures

### Automatic prompt-time recall

Host plugins also use bounded automatic recall in two places:

- session start, where continuity and durable memory are injected once per session
- before-turn, where a narrow proactive recall pass can surface durable memory or a canonical procedure for a live user turn

These paths reuse the same recall concepts, but they are not the same thing as calling the public recall tool directly.

## Code map

- `src/cli/commands/recall.ts` - CLI option parsing and entry recall formatting
- `src/app/recall/unified.ts` - routed recall across entries, episodes, and procedures
- `src/app/recall/types.ts` - unified recall request and response types
- `src/app/procedures/recall/service.ts` - procedure retrieval and canonical selection
- `src/app/session-start/service.ts` - session-start durable recall selection
- `src/app/before-turn/service.ts` - proactive before-turn durable and procedure recall
- `src/core/recall/search.ts` - entry recall pipeline orchestration
- `src/core/recall/scoring.ts` - entry recall score math
- `src/core/recall/fusion.ts` - reciprocal rank fusion
- `src/core/recall/lexical.ts` - lexical tokenization and query planning
- `src/core/recall/neighborhood.ts` - neighborhood expansion shapes and seeded rerank helpers
- `src/core/recall/mmr.ts` - maximal marginal relevance diversification
- `src/core/recall/cross-encoder.ts` - cross-encoder rerank orchestration
- `src/core/recall/temporal.ts` - entry-side temporal parsing and `around` inference
- `src/core/recall/trace.ts` - typed execution trace summaries
- `src/core/recall/types.ts` - entry recall inputs, outputs, candidates, and filters
- `src/core/episode/search.ts` - episode retrieval modes
- `src/core/episode/scoring.ts` - temporal episode score math
- `src/core/episode/temporal-window.ts` - episode time-window parsing
- `src/core/episode/types.ts` - episode query and result types
- `src/core/ports.ts` - recall and episode ports
- `src/adapters/db/recall-adapter.ts` - libSQL entry retrieval, hydration, neighborhood expansion, and telemetry writes
- `src/adapters/db/episode-queries.ts` - episode overlap lookup and vector search
- `src/adapters/db/queries.ts` - recall event persistence
- `src/adapters/cross-encoder/openai-cross-encoder.ts` - OpenAI-backed cross-encoder port
- `src/adapters/openclaw/tools/recall.ts` - `agenr_recall` tool wiring
- `src/adapters/openclaw/tools/shared.ts` - human-readable unified recall formatting
- `src/adapters/openclaw/hooks/before-prompt-build.ts` - automatic session-start and before-turn recall injection

## Architecture split

Recall is intentionally split between core and adapters.

Core owns:

- query normalization
- ranking
- fusion
- claim-key-aware shaping
- thresholding
- budgeting
- routing
- trace summaries

Adapters own:

- vector lookup
- full-text lookup
- SQL-pushable filters
- entry hydration
- episode overlap queries
- recall telemetry writes

That split keeps ranking logic pure and makes degraded-mode behavior explicit. Query embeddings or vector lookup can fail, and core can still continue with lexical recall when the caller allows degradation.

## Unified recall model

Unified recall sits above entry-only CLI recall and decides which memory surfaces to query.

### Modes

Unified recall accepts four modes:

- `auto` - route heuristically
- `entries` - durable entries only
- `episodes` - episodes only
- `procedures` - procedures only

### Routing concepts

The router looks for a few kinds of intent:

- factual questions
- entity-attribute questions
- procedural questions
- historical-state questions
- temporal or narrative questions
- mixed questions with both topic and time anchors

Important concepts:

- a topic anchor means the query is about a specific subject
- a supported time expression means the query can be grounded to a resolved time window
- historical-state intent means the user is asking about a prior version of something, not just the current fact

Typical routing behavior:

- factual questions usually query entries
- procedural questions usually query procedures, and may also query entries or episodes when the query has topic or time anchors
- narrative questions with a time window usually query episodes
- historical-state questions often query both entries and episodes

Unified recall returns separate sections rather than one mixed ranked list. Durable memory, episode context, and procedure candidates remain visibly distinct because they carry different authority.

## CLI entry recall surface

The standalone CLI currently exposes the entry-recall path:

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

Key CLI knobs:

- `--limit` - maximum result count, default `10`
- `--threshold` - inclusive score cutoff in `0-1`
- `--budget` - approximate token budget applied after scoring
- `--types` - entry-type filter
- `--tags` - exact tag filter
- `--since`, `--until` - hard date filters
- `--around` - anchor date for recency scoring
- `--around-radius` - Gaussian radius in days, default `14`
- `--verbose` - include score breakdowns

## Entry recall pipeline

The durable entry pipeline is the core hybrid recall path.

### 1. Input normalization

`recall()` normalizes the input before retrieval:

- empty or whitespace-only query returns no results
- `limit` defaults to `10`
- `threshold` is clamped into `0-1`
- `budget` becomes `null` when omitted or invalid
- `limit = 0` returns immediately

### 2. Hard filters and time parsing

Entry recall has two different temporal concepts:

- `since` and `until` are hard filters
- `around` is a scoring bias

Hard filters:

- `types` become SQL `IN (...)`
- `tags` are exact JSON-array membership checks
- multiple tags are ANDed together
- `since` and `until` are inclusive comparisons on `created_at`

Active entry filtering is always applied on the default path:

- `retired = 0`
- `superseded_by IS NULL`

### 3. Query embedding

When embeddings are available, recall embeds the query once and uses that vector for semantic retrieval.

If embedding generation fails:

- entry recall can degrade to lexical-only mode
- unified recall may emit notices instead of failing
- explicit entry-only calls can still choose to fail rather than silently degrade, depending on the caller

### 4. Candidate retrieval

Entry recall runs vector and lexical retrieval in parallel.

#### Vector retrieval

The vector path:

1. overfetches with `limit * 4`
2. uses the vector index
3. reapplies active and user filters
4. recomputes cosine similarity in TypeScript
5. drops non-positive similarities
6. sorts by similarity

#### Lexical retrieval

The lexical path:

1. overfetches with `limit * 2`
2. builds a lexical plan from the query
3. runs lexical tiers in order
4. keeps the first hit per entry ID
5. sorts by tier priority and BM25

Current lexical tiers:

- `exact`
- `all_tokens`
- `any_tokens`

Tokenization is deliberately simple:

- lowercase Unicode-aware normalization
- regex token extraction
- stop-word removal
- FTS operator-word removal from token tiers

If tokenization yields no usable tokens, recall still attempts exact-phrase search.

### 5. Candidate merge

Candidates are merged by entry ID.

Important properties:

- an entry can arrive from vector, lexical, or both
- duplicate IDs collapse into one candidate
- vector similarity and lexical evidence are preserved separately
- lexical overlap remains visible as evidence even though it is no longer the composite relevance signal

## Entry scoring model

Entry ranking is built from distinct signals.

### Lexical evidence score

`computeLexicalScore()` combines:

- token-overlap ratio over subject and content
- phrase-match bonus for matching multi-token sequences, capped at `0.4`
- exact subject-match bonus of `0.3`

This lexical score is now evidence-only. It informs explanations and trace output, but it does not directly drive the composite relevance score.

### Relevance via reciprocal rank fusion

Composite relevance is driven by reciprocal rank fusion, or RRF.

`rrfFuse()` combines ordered candidate lists from the retrieval channels using:

```txt
raw_rrf(id) = sum(1 / (rankIndex + k))
```

Where:

- each retrieval channel contributes one ordered list
- `k` is the rank constant
- duplicates within one channel count once
- empty channels do not affect normalization

The raw score is normalized so that a candidate ranked first in every active channel maps to `1.0`.

This matters because entry recall can fuse:

- vector ranking
- lexical ranking
- historical-neighborhood expansions when the historical-state profile is active

### Recency score

Without an `around` anchor:

- `core` expiry scores `1`
- `permanent` expiry uses a `365` day half-life
- `temporary` expiry uses a `30` day half-life

With an `around` anchor:

- recency becomes Gaussian date proximity
- default radius is `14` days
- expiry type no longer changes the formula

Conceptually:

```txt
recency = gaussian(distance_from_anchor_days, radius_days)
```

### Importance score

Importance maps the `1-10` domain into the `0.4-1.0` range.

### Final entry score

The final entry score is:

```txt
score = relevance * 0.5 + recency * 0.25 + importance * 0.25
```

All component scores and the final score are clamped into `0-1`.

### Threshold and raw-evidence gating

Thresholding happens after retrieval and scoring, not before.

Important consequences:

- retrieval overfetches first
- low-scoring results are discarded only after the composite score exists
- weak vector-only drift cannot be rescued by recency or importance alone
- lexical support is sufficient raw evidence
- vector-only candidates must clear a minimum raw similarity floor

`entity_attribute` recall adds a stricter precision gate, because narrow attribute questions benefit from returning fewer results rather than adjacent semantic noise.

## Neighborhood expansion and lineage-aware rerank

Recall uses two related concepts to preserve coherence around claim families, supersession chains, and other local neighborhoods.

### Bounded neighborhood expansion

Neighborhood expansion is an adapter-scoped sweep over typed lineage families. Supported families are:

- `supersession_chain`
- `claim_key_sibling`
- `procedure_revision`
- `session_family`
- `topic_family`

The expansion request carries:

- requested families
- a hard budget
- whether retired rows are allowed

### Seeded rerank

`seededRerank()` uses the strongest current leaders as seeds and gives a small lift to candidates that share lineage with those leaders.

This is intentionally conservative:

- unrelated candidates do not get lifted
- the rerank reinforces structure already present in the pool
- it does not replace the underlying relevance model

## Historical-state entry recall

Historical-state recall is a ranking variant for questions such as:

- what was the previous approach
- what changed
- what did we use before

When `rankingProfile: "historical_state"` is active, entry recall changes behavior in a few ways:

1. it expands into supersession chains, claim-key siblings, and retired topic-family candidates
2. it flattens default recency to a neutral value when there is no explicit time anchor
3. it applies lineage bonuses for plausible prior-state matches
4. it applies claim-key trust and redundancy penalties to reduce current-state dominance
5. it runs seeded rerank over the historical pool

This profile exists because historical-state questions are not asking for the best current fact. They are asking for the right earlier fact.

### Historical-state shaping signals

The score breakdown can include:

- `historicalLineage`
- `neighborhoodBoost`
- `claimKeyTrustPenalty`
- `claimKeyRedundancyPenalty`

These signals are additive or subtractive shaping terms on top of the base composite.

## MMR diversification

After fusion and lineage-aware shaping, recall can apply maximal marginal relevance, or MMR, to diversify the shortlist.

MMR balances:

- relevance to the query
- dissimilarity from already-selected candidates

Conceptually:

```txt
mmr(candidate) = lambda * relevance - (1 - lambda) * max_similarity_to_selected
```

Design properties:

- MMR uses the already-shaped composite relevance, not a fresh relevance model
- candidates without embeddings pass through without similarity math
- tiny pools can skip MMR entirely
- ties are broken by original order

MMR is most useful when the shortlist contains redundant near-duplicates. It is intentionally weaker on small pools where diversification can easily flip a correct top-1 into an odd but merely different result.

## Cross-encoder rerank

Recall can optionally apply a cross-encoder rerank after MMR.

The cross-encoder:

- looks at the query and passage together
- produces a normalized relevance score per candidate
- only touches a top-K shortlist
- blends with the prior composite score instead of replacing it

Blend equation:

```txt
rescored = alpha * crossEncoderScore + (1 - alpha) * priorScore
```

Design properties:

- failures are fail-closed, so a provider error becomes a pass-through
- top-K keeps the stage bounded
- the earlier ranking pipeline still matters because the rerank is a blend, not a reset

## Budgeting and hydration

After ranking:

1. thresholding removes weak candidates
2. an optional token budget is applied greedily in score order
3. the ranked IDs are hydrated into full entries
4. the final list is sliced to `limit`

The budget estimator is intentionally simple:

```txt
approx_tokens = (subject.length + content.length) / 4
```

The first threshold-qualified result is always kept even if it alone exceeds the budget.

## Episode recall

Episode recall has three internal modes:

1. pure temporal
2. pure semantic
3. hybrid temporal plus semantic

## Episode temporal windows

Episode recall uses a dedicated calendar-aware parser. It produces:

- the resolved window
- concrete `start` and `end` bounds
- the runtime timezone
- `resolvedFrom`, the phrase that produced the window

Supported concepts include:

- `today`
- `yesterday`
- `this week`, `last week`
- `this month`, `last month`
- `N days ago`
- `N weeks ago`
- `N months ago`
- month names such as `in March`
- month-day phrases such as `March 15`
- weekday phrases such as `last Friday`
- ISO dates

Important behaviors:

- `today`, `this week`, and `this month` end at `now`
- closed historical periods resolve to full calendar intervals
- `N weeks ago` and `N months ago` resolve to anchor windows with a small radius
- month-day queries resolve to the most recent matching date

## Episode retrieval modes

### Pure temporal

Pure temporal episode recall:

1. resolves a time window
2. fetches overlapping episodes through SQL
3. scores them in memory
4. sorts primarily by temporal fit

The overlap filter is inclusive:

```txt
started_at <= query_end
COALESCE(ended_at, started_at) >= query_start
```

### Pure semantic

Pure semantic episode recall:

- requires embeddings
- uses episode vector search
- ranks by semantic similarity

### Hybrid episode recall

Hybrid episode recall is not a broad vector search with a soft time bias.

It is:

1. hard temporal filtering first
2. semantic reranking inside the filtered set
3. RRF fusion between temporal and semantic rank lists

This preserves the date boundary. A semantically good episode from the wrong time window should not outrank a weaker but temporally correct episode.

## Episode scoring

Pure temporal episode ranking uses:

```txt
score = overlapQuality * 0.75 + midpointProximity * 0.20 + activity * 0.04 + recency * 0.01
```

Where:

- `overlapQuality` measures how well the episode interval matches the query interval
- `midpointProximity` rewards closeness to the center of the window
- `activity` lightly rewards more substantial sessions
- `recency` is only a final tiebreak signal

In hybrid mode, the fused RRF score becomes the main relevance signal, with temporal and activity signals acting as secondary ordering information.

## Procedure recall

Procedure recall is a dedicated path rather than a thin alias for entry recall.

Key ideas:

- procedure questions want canonical operational guidance
- revisions of the same procedure are often close in lexical and semantic space
- the procedure surface therefore benefits from lineage-aware handling, MMR, and optional cross-encoder rerank just like other recall surfaces

Unified recall returns:

- one canonical procedure answer when the service finds a stable leader
- ranked procedure candidates separately from entries and episodes
- procedure notices when the path had to degrade

## Automatic host recall

OpenClaw and Skeln use the same bounded automatic recall app services through different host hooks.

### Session-start recall

Session-start recall:

- runs once per session
- merges continuity context with durable memory
- keeps continuity and durable memory visibly separate
- caps the durable-memory patch to a small bounded set
- prefers artifact-grounded durable memory for non-core context

### Before-turn recall

Before-turn recall:

- runs only on later user-facing turns
- skips low-signal or non-user triggers
- derives a bounded query from the current prompt plus recent turns
- can surface one or a few high-confidence durable items
- can also surface a canonical procedure suggestion

This path is intentionally stricter than the explicit recall tool. It is meant to assist live prompting, not dump broad memory into the prompt by default.

## Notices, degradation, and fallbacks

Recall surfaces explicit notices when parts of the pipeline degrade.

Common degraded cases:

- query embedding unavailable
- vector search unavailable
- semantic episode search unavailable
- lexical-only procedure selection

The core design principle is graceful fallback:

- lexical recall should still work when vector recall does not
- temporal episode recall should still work when semantic episode search does not
- a broken rerank stage should never produce worse-than-baseline failure semantics

## Trace and telemetry

Recall has two different observability layers.

### Trace summaries

Typed trace summaries capture execution facts such as:

- filters
- ranking settings
- candidate counts
- claim-key shaping
- RRF details
- neighborhood expansion details
- MMR details
- cross-encoder details
- degraded-mode notices
- timings

Tracing is observational only. It should not change ranking behavior.

### Recall telemetry

Recall telemetry records that results were surfaced.

For recalled entries, telemetry updates:

- `recall_count`
- `last_recalled_at`
- `recall_events`

Telemetry failures are swallowed so the user still receives results.

### Replay debug artifacts

The internal eval seams described in [docs/EVALS.md](./EVALS.md) can emit a bounded, versioned `debugArtifact` on successful responses when the caller sets `options.includeDebugArtifact` to `true`. Artifacts mirror the stable fields reported in the typed trace summary (candidate counts, ranking, degraded, routing) and add a small top-K candidate breakdown sourced from the claim-centric projection.

Key properties carried into the artifact:

- artifacts never run inside `src/core/`; they are assembled in the app layer from the same diagnostics the eval seams already surface
- artifacts are opt-in, omitted by default, and bounded by `options.topKCandidates` (seam-enforced maximum)
- artifact payloads are versioned through `schemaVersion` so `agenr-evals` can assert shape stability and require explicit bumps for any future change

See [docs/EVALS.md](./EVALS.md#replay-debug-artifacts) for the full artifact contract for both the recall and before-turn seams.

## Tuning knobs

Recall exposes several practical tuning knobs across the CLI, unified recall, and ranking policy.

### Query-surface knobs

- `limit` - maximum number of returned results
- `threshold` - inclusive `0-1` score cutoff
- `budget` - approximate token budget applied after scoring
- `types` - entry-type filter
- `tags` - exact tag filter
- `since`, `until` - hard date filters
- `around` - date anchor for recency scoring
- `aroundRadiusDays` - Gaussian radius for `around`

### Unified routing knobs

- `mode` - `auto`, `entries`, `episodes`, or `procedures`
- explicit time-window phrases - push routing toward episodes
- topic anchors - can pull mixed questions toward entries plus episodes or procedures

### Ranking-policy knobs

- `rrf` - enable or disable reciprocal rank fusion
- `rrfRankConstant` - main RRF rank constant, default `60`
- `rrfSmallPoolRankConstant` - sharper RRF constant for small pools, default `8` when the fused pool is at or below `4` candidates
- `neighborhood` - enable or disable expansion plus seeded rerank
- `mmr` - enable or disable diversification
- `mmrLambda` - relevance versus diversity balance, default `0.7`
- `mmrMinPoolSize` - minimum pool size before MMR runs, default `4`
- `crossEncoder` - enable or disable cross-encoder rerank
- `crossEncoderTopK` - shortlist size for the reranker, default `10`
- `crossEncoderAlpha` - blend weight for reranked scores, default `0.6`

### Surface-specific defaults that matter

- entry recall default `limit` is `10`
- entry `around` default radius is `14` days
- recency half-life is `365` days for `permanent` and `30` days for `temporary`
- entry final score weights are `0.5 relevance`, `0.25 recency`, `0.25 importance`
- episode temporal score weights are `0.75 overlapQuality`, `0.20 midpointProximity`, `0.04 activity`, `0.01 recency`

## Memory authority model

Not all recalled material should be treated the same way.

1. Durable entries are the canonical memory record for facts, decisions, preferences, and claim-key-managed state.
2. Episodes are narrative history. They are good for context, but they are weaker than durable entries for precision-sensitive facts.
3. Procedures are canonical guidance for how to perform a task.
4. Live verification still wins over any stored memory when direct evidence is cheap to obtain.

This is why the system keeps these surfaces separated in both internal types and user-facing formatting.

## Recall-relevant configuration

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

Important config notes:

- embeddings use `credentials.openaiApiKey`, then `OPENAI_API_KEY`
- embeddings default to `text-embedding-3-small`
- the cross-encoder model is optional
- `AGENR_DB_PATH` overrides `dbPath`
- `AGENR_CONFIG_PATH` overrides the config file location

## Good files to read before changing recall

- `src/cli/commands/recall.ts`
- `src/app/recall/unified.ts`
- `src/app/recall/types.ts`
- `src/app/procedures/recall/service.ts`
- `src/app/session-start/service.ts`
- `src/app/before-turn/service.ts`
- `src/core/recall/search.ts`
- `src/core/recall/scoring.ts`
- `src/core/recall/fusion.ts`
- `src/core/recall/lexical.ts`
- `src/core/recall/neighborhood.ts`
- `src/core/recall/mmr.ts`
- `src/core/recall/cross-encoder.ts`
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
- `src/adapters/cross-encoder/openai-cross-encoder.ts`
- `src/adapters/openclaw/tools/recall.ts`
- `src/adapters/openclaw/tools/shared.ts`
- `src/adapters/openclaw/hooks/before-prompt-build.ts`
