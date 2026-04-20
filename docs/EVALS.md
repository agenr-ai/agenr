# Evals

`agenr` currently exposes two internal eval seams on one local-only HTTP server:

- a recall seam used by `agenr-evals` to run isolated case-local recall requests against real `agenr` behavior, including degraded lexical fallback, unified recall, and procedure-aware auto routing inside unified recall
- a before-turn seam used by `agenr-evals` to run isolated case-local `runBeforeTurn()` requests against the real app-layer selector and prompt renderer

The current contract is intentionally shaped around production parity rather than backward compatibility. The recall seam distinguishes:

- core-path evals that exercise the same `recall()` path as the CLI
- unified-path evals that exercise the same `runUnifiedRecall()` path and caller context as the OpenClaw recall tool

These seams are intentionally small:

- one transport host: the internal eval dev server
- two routes: `POST /internal/evals/recall/run` and `POST /internal/evals/before-turn/run`
- two eval families: recall and before-turn
- one case shape per family: one request in, one response out
- one provisioning mode: exact fixture seeding into an isolated SQLite sandbox

It is not a general eval platform. `agenr-evals` owns manifests, suite orchestration, artifacts, comparisons, summaries, and reporting. `agenr` owns the execution seam.

This document describes the code as it exists today.

## Code map

- `package.json` - `internal:eval-server` preferred dev script plus `internal:recall-eval-server` compatibility alias
- `src/internal-eval-server.ts` - dev-only entry point that resolves host and port, starts the shared server, and handles shutdown
- `src/internal-recall-eval-server.ts` - compatibility entry point that forwards to the shared server
- `src/adapters/api/internal-eval-server.ts` - tiny Node HTTP server with the internal eval route set
- `src/adapters/api/internal-eval-routes.ts` - deterministic route registry for the internal eval server
- `src/adapters/api/routes/internal-before-turn-eval.ts` - thin `POST /internal/evals/before-turn/run` route and boundary error mapping
- `src/adapters/api/routes/internal-recall-eval.ts` - thin `POST /internal/evals/recall/run` route and boundary error mapping
- `src/adapters/api/validation/before-turn-eval-request.ts` - strict JSON request validation for before-turn eval cases
- `src/adapters/api/validation/internal-eval-shared.ts` - shared sandbox and fixture validation helpers
- `src/app/evals/before-turn/contracts.ts` - stable before-turn request, response, output, and timing types
- `src/app/evals/before-turn/run-before-turn-eval-case.ts` - top-level app service that sets up the sandbox, provisions fixtures, runs `runBeforeTurn()`, and normalizes the response
- `src/app/evals/before-turn/normalize-response.ts` - stable success and error envelope shaping for before-turn evals
- `src/adapters/api/validation/recall-eval-request.ts` - strict JSON request validation and unexpected-field rejection
- `src/app/evals/recall/contracts.ts` - stable request, response, diagnostics, timing, sandbox, and execution-path types
- `src/app/evals/recall/run-recall-eval-case.ts` - top-level app service that sets up the sandbox, provisions fixtures, runs recall, and normalizes the response
- `src/app/evals/recall/sandbox.ts` - isolated sandbox directory and case-local database lifecycle
- `src/app/evals/recall/provision-fixtures.ts` - exact fixture seeding with deterministic ID generation and embedding generation
- `src/app/evals/recall/instrumented-recall-ports.ts` - adapter-boundary wrappers that collect timings and counts
- `src/app/evals/recall/collect-diagnostics.ts` - diagnostics collector that merges app observations with the core trace summary
- `src/app/evals/recall/normalize-response.ts` - stable success and error envelope shaping
- `src/app/recall/unified.ts` - unified recall routing used when `recallPath: "unified"`
- `src/core/recall/index.ts` and `src/core/recall/trace.ts` - the real recall algorithm plus the typed trace sink used for eval diagnostics
- `tests/app/evals/recall/*.test.ts` and `tests/adapters/api/*.test.ts` - coverage for orchestration, validation, route behavior, and local server behavior

## Architecture boundaries

The split is deliberate:

- `core/` owns real recall behavior and trace summaries
- `app/evals/before-turn/` owns isolated sandbox execution for the app-layer before-turn selector
- `app/evals/recall/` owns sandbox setup, exact fixture provisioning, diagnostics assembly, and response normalization
- `app/recall/` owns unified recall routing when the eval request selects that path
- `adapters/api/` owns JSON parsing, request validation, and HTTP mapping
- `agenr-evals` owns manifests, suites, artifacts, scoring, summaries, and reporting

Current explicit non-goals:

- no public eval API
- no `agenr eval ...` CLI command
- no suite orchestration inside `agenr`
- no benchmark scoring or pass/fail policy inside `agenr`
- no trace-file or candidate-snapshot artifact system
- no fixture CRUD API
- no second transport layer beyond the shared internal eval server

## Surface

There is no user-facing eval CLI command.

The current developer surface is:

```bash
pnpm internal:eval-server
```

Compatibility alias:

```bash
pnpm internal:recall-eval-server
```

The preferred script currently runs:

```bash
pnpm run build:root
node dist/internal-eval-server.js
```

The local server exposes exactly two routes:

```txt
POST /internal/evals/recall/run
POST /internal/evals/before-turn/run
```

Defaults:

- host: `127.0.0.1`
- port: `4010`

Preferred optional overrides:

- `AGENR_INTERNAL_EVAL_HOST`
- `AGENR_INTERNAL_EVAL_PORT`

Compatibility overrides still honored by the shared server entrypoint:

- `AGENR_INTERNAL_RECALL_EVAL_HOST`
- `AGENR_INTERNAL_RECALL_EVAL_PORT`

Server behavior is intentionally tiny:

- any other path returns `404 Not found.`
- any other method on either route returns `405` with `Allow: POST`

## Before-turn seam

The before-turn seam is the primary feature seam for selector-quality testing. It exercises the real `runBeforeTurn()` app service against isolated seeded state instead of inferring behavior from recall-only output.

The local route is:

```txt
POST /internal/evals/before-turn/run
```

Top-level request shape:

```json
{
  "caseId": "duke-identity-01",
  "memoryPool": [],
  "procedurePool": [],
  "beforeTurnInput": {
    "sessionKey": "agent:main:test",
    "currentTurnText": "who is Duke?",
    "recentTurns": [
      {
        "role": "assistant",
        "text": "We were just talking about dogs."
      }
    ],
    "trigger": "user",
    "policy": {
      "enableDurableRecall": true,
      "enableProcedureSuggestion": false,
      "maxRecentTurns": 2,
      "maxQueryChars": 450,
      "maxDurableEntries": 1,
      "maxHighConfidenceDurableEntries": 2,
      "maxProcedureCandidates": 3,
      "recallThreshold": 0.25,
      "highConfidenceRecallThreshold": 0.9,
      "procedureThreshold": 0.7,
      "skipTrivialTurns": false,
      "requireTurnSignal": false
    }
  },
  "options": {
    "includeDiagnostics": true,
    "includeRenderedPatch": true,
    "includeTimings": true
  }
}
```

Successful responses include:

- `output.abstained`
- `output.selectedEntryIds`
- `output.selectedProcedureKey`
- `output.patch`
- optional `output.renderedPatchText`
- optional `diagnostics`
- `diagnostics.queryPolicy`
- `diagnostics.queryVariants`
- optional `diagnostics.directness`
- `diagnostics.abstentionReasons`
- optional `timings`
- `sandbox`

Current explicit non-goals for this seam:

- no OpenClaw `before_prompt_build` eval route
- no raw candidate dumps
- no scoring, manifests, or answer-lift logic inside `agenr`

### Before-turn request contract

The request type is `BeforeTurnEvalCaseRequest` from [src/app/evals/before-turn/contracts.ts](../src/app/evals/before-turn/contracts.ts).

Top-level request semantics:

- `caseId` is required and echoed back whenever the boundary can safely do so
- `description` is optional and informational only
- `sandbox` is optional and controls where the isolated database lives, whether it is preserved, and how the corpus is seeded through `sandbox.corpusSeed`
- `memoryPool` is required but may be an empty array
- `procedurePool` is optional and seeds isolated procedure fixtures for procedure-aware cases
- `beforeTurnInput.currentTurnText` is required
- `beforeTurnInput.recentTurns` is optional and preserves the compact recent-turn window forwarded to `runBeforeTurn()`
- `options.includeDiagnostics` enables the top-level mirrored diagnostics payload
- `options.includeRenderedPatch` enables adapter-format prompt rendering
- `options.includeTimings` enables timing metadata

Supported `beforeTurnInput.policy` fields at the HTTP boundary:

- `enableDurableRecall`
- `enableProcedureSuggestion`
- `maxRecentTurns`
- `maxQueryChars`
- `maxDurableEntries`
- `maxHighConfidenceDurableEntries`
- `maxProcedureCandidates`
- `recallThreshold`
- `highConfidenceRecallThreshold`
- `procedureThreshold`
- `skipTrivialTurns`
- `requireTurnSignal`

Boundary validation details:

- integer count fields must be non-negative integers
- threshold fields must be numbers from `0-1`
- boolean gates must be booleans
- unexpected fields are rejected on the top-level request, `beforeTurnInput`, each recent turn, `beforeTurnInput.policy`, and `options`

Current production defaults for the threshold knobs live in `src/app/before-turn/service.ts`. They are also recorded in the "Ranking policy tuning history" section of [docs/RECALL.md](./RECALL.md), so harness authors running A/B comparisons can see what the seam falls back to when a case omits a policy field. The `highConfidenceRecallThreshold` value shown in the example above is illustrative; cases that want the live default should simply omit the field.

### Before-turn diagnostics

When diagnostics are included, the seam mirrors the real `runBeforeTurn()` diagnostics. The stable fields most useful to `agenr-evals` are:

- `diagnostics.query` - the final durable-recall query that actually ran
- `diagnostics.queryPolicy` - whether the selector stayed `current_only`, required context immediately, or retried with contextual fallback
- `diagnostics.queryVariants` - each attempted query variant with its candidate count and selection status
- `diagnostics.directness` - optional directness rerank output including query kind, entity, decision, winner gap, and candidate-level signals
- `diagnostics.abstentionReasons` - typed selector reasons for skipping, failing to find a stable winner, or disabling a retrieval path
- `diagnostics.notices` - degraded-mode and expansion notices preserved from the live selector

These diagnostics let `agenr-evals` compare current-only, contextual-required, contextual-fallback, rerank-only, and combined selector behavior without reading raw candidate dumps.

### Before-turn snapshot replay

The before-turn seam reuses the same `sandbox` contract as the recall seam, including the optional `sandbox.corpusSeed` block described under [Corpus seeding](#corpus-seeding). Harnesses can therefore replay a before-turn case against a copied production-like snapshot with the exact same shape as a recall case:

```json
{
  "sandbox": {
    "preserve": false,
    "corpusSeed": {
      "mode": "snapshot_copy",
      "snapshotDbPath": "/path/to/knowledge-snapshot.db",
      "snapshotId": "2026-04-18-nightly",
      "snapshotLabel": "nightly corpus snapshot",
      "allowTelemetryWrites": false
    }
  }
}
```

Before-turn-specific behavior on top of the shared contract:

- `memoryPool` and `procedurePool` overlays still apply on top of the copied snapshot, so scenario-specific fixtures behave the same in fixture and snapshot replay modes
- when `allowTelemetryWrites` is `false` (the default), the durable-recall stage of `runBeforeTurn()` runs through a telemetry-gated port so `recordRecallEvents` becomes a no-op and the copied snapshot stays read-only-like at the telemetry layer
- when `allowTelemetryWrites` is `true`, normal recall telemetry writes run against the copied sandbox database (never the source)
- the source snapshot file is never opened as a database; it is only copied into the sandbox

Successful responses include snapshot metadata under `sandbox.snapshot` when the case used `snapshot_copy`, mirroring the recall seam:

- `sandbox.snapshot.id`
- `sandbox.snapshot.label`
- `sandbox.snapshot.dbPathBasename`
- `sandbox.snapshot.allowedTelemetryWrites`

## Recall Request Contract

The request type is `RecallEvalCaseRequest` from [src/app/evals/recall/contracts.ts](../src/app/evals/recall/contracts.ts).

Top-level shape:

```json
{
  "caseId": "case-123",
  "description": "optional human-readable note",
  "recallPath": "core",
  "sandbox": {
    "root": "/tmp/agenr-eval-case",
    "preserve": true
  },
  "memoryPool": [
    {
      "id": "fixture-1",
      "type": "fact",
      "subject": "pager policy",
      "content": "Taylor is on call this week."
    }
  ],
  "recallRequest": {
    "text": "who is on call this week",
    "limit": 5
  },
  "unified": {
    "mode": "entries",
    "sessionKey": "agent:test:tui",
    "memoryPolicy": {
      "slotPolicies": {
        "attributeHeads": {
          "owner": "multivalued"
        }
      }
    }
  },
  "options": {
    "includeDiagnostics": true,
    "includeCandidates": true,
    "includeTimings": true,
    "faultInjection": {
      "queryEmbeddingFailure": true
    }
  }
}
```

Important request semantics:

- `caseId` is required and echoed back whenever the boundary can safely do so
- `description` is optional and informational only
- `recallPath` is optional and defaults to `"core"`
- `sandbox` is optional and controls where the isolated database lives, whether it is preserved, and how the corpus is seeded through `sandbox.corpusSeed`
- `memoryPool` is required but may be an empty array
- the current HTTP boundary does not yet accept `procedurePool`, even though the app-layer eval contracts include procedure fixtures for direct-service tests
- `recallRequest` is required
- `unified` is optional and is only valid when `recallPath: "unified"`
- `options.includeDiagnostics` enables structured diagnostics
- `options.includeCandidates` does not return raw candidates - it only enables the same aggregate diagnostics used by the harness
- `options.includeTimings` enables timing metadata
- `options.faultInjection` is an internal-only deterministic degradation hook for eval corpora and tests; it is not part of any public product surface

### Supported `recallPath` values

- `"core"` - run the real core recall pipeline
- `"unified"` - run the higher-level unified recall router and return its entry results plus unified metadata

`"core"` is still the default path.

### Fixture entry rules

Each `memoryPool` item supports these fields:

- `id`
- `type`
- `subject`
- `content`
- `importance`
- `expiry`
- `tags`
- `source_file`
- `source_context`
- `created_at`
- `updated_at`
- `retired`
- `retired_at`
- `retired_reason`
- `superseded_by`
- `claim_key`
- `claim_key_status`
- `claim_key_source`
- `claim_support_source_kind`
- `claim_support_locator`
- `claim_support_observed_at`
- `claim_support_mode`
- `valid_from`
- `valid_to`
- `supersession_kind`
- `supersession_reason`

Boundary validation details:

- `type` must be one of the live `EntryType` values
- `expiry` must be one of the live `Expiry` values
- `importance` must be an integer from `1-10`
- `created_at`, `updated_at`, `retired_at`, `claim_support_observed_at`, `valid_from`, and `valid_to` must be parseable timestamps
- `tags` must be a string array
- claim-key enums must match the live lifecycle/source/mode unions
- unsupported fields are rejected

### `recallRequest` rules

The boundary accepts these fields:

- `text`
- `limit`
- `threshold`
- `budget`
- `types`
- `tags`
- `since`
- `until`
- `around`
- `aroundRadius`
- `rankingProfile`
- `rankingPolicy`

Boundary validation details:

- `text` must be a non-empty string
- `limit` and `budget` must be non-negative integers
- `threshold` must be a number from `0-1`
- `aroundRadius` must be a positive integer
- `types` must be valid entry types
- `tags` must be a string array
- `rankingProfile`, when present, must currently be `historical_state`
- `since`, `until`, and `around` are only validated as non-empty strings at the HTTP boundary today
- `rankingPolicy`, when present, must be an object with a bounded set of tuning knobs (see below)

### `rankingPolicy` rules

The `rankingPolicy` block surfaces the core ranking-stage controls on `RecallExecutionOptions.rankingPolicy` to the eval harness so `agenr-evals` can toggle each stage independently without rebuilding the rest of the policy.

Supported fields:

- `rrf` - reciprocal rank fusion stage toggle, either `"enabled"` or `"disabled"`
- `rrfRankConstant` - RRF rank-constant override, positive integer
- `neighborhood` - neighborhood expansion plus seeded-rerank stage toggle
- `mmr` - MMR diversification stage toggle
- `mmrLambda` - MMR balance parameter, number in `[0, 1]`
- `crossEncoder` - cross-encoder rerank stage toggle
- `crossEncoderTopK` - cross-encoder shortlist size, positive integer
- `crossEncoderAlpha` - cross-encoder blend weight, number in `[0, 1]`

Boundary validation details:

- every stage toggle must be exactly `"enabled"` or `"disabled"`
- `rrfRankConstant` and `crossEncoderTopK` must be positive integers
- `mmrLambda` and `crossEncoderAlpha` must be numbers from `0-1`
- an empty `rankingPolicy` object normalizes to omitted on the wire
- unexpected fields are rejected

The policy is forwarded as one `RecallRankingPolicy` object into `core/recall` and into `runUnifiedRecall()` so a single validated policy drives entry, episode, and procedure recall on every case.

Execution-path nuance that matters:

- on the `"core"` path, `runRecallEvalCase()` forwards the full validated `recallRequest` object to `core/recall`, including `rankingPolicy`
- on the `"unified"` path, the seam only accepts the subset that real unified callers use today: `text`, `limit`, `threshold`, `types`, `tags`, `rankingPolicy`, and `asOf`
- `budget`, `since`, `until`, `around`, `aroundRadius`, and caller-supplied `rankingProfile` are rejected on the unified path instead of being silently ignored

### `unified` rules

The `unified` block mirrors real unified caller context rather than core recall input.

Supported fields:

- `mode`
- `sessionKey`
- `memoryPolicy.slotPolicies.attributeHeads`

Boundary validation details:

- `mode` must be one of `auto`, `entries`, or `episodes`
- `sessionKey` must be a non-empty string when present
- `memoryPolicy.slotPolicies.attributeHeads` must be an object keyed by canonical attribute-head labels
- each attribute-head policy must be `exclusive` or `multivalued`
- the `unified` block is rejected unless `recallPath` is `"unified"`

Even without an explicit `procedures` mode at the HTTP boundary, `mode: "auto"` can still route into procedures when the query text looks procedural.

### Boundary strictness

The HTTP boundary rejects unexpected fields for:

- the top-level request object
- `sandbox`
- `sandbox.corpusSeed`
- each fixture entry
- `recallRequest`
- `options`

Invalid JSON or invalid request shapes return a structured `400` response with:

- `status: "error"`
- `error.code: "invalid_request"`
- field-level validation issues
- `caseId` when the boundary can confidently parse a non-empty one

## End-to-end flow

### 1. Local server startup

`pnpm internal:eval-server` builds `dist/internal-eval-server.js` from the root package, then starts the shared internal eval dev server. The compatibility alias `pnpm internal:recall-eval-server` starts the same server.

The runtime entry point:

- resolves host and port from the environment
- starts the local-only HTTP server
- prints the base URL plus served route paths
- prints a single-line cross-encoder status reflecting the startup resolution (`configured`, `not_configured`, or `unavailable`)
- installs `SIGINT` and `SIGTERM` handlers for graceful shutdown

### 2. HTTP boundary validation

`createInternalRecallEvalRoute()` does the following:

1. parses the request body as JSON
2. validates and normalizes it through `parseRecallEvalCaseRequest()`
3. delegates the typed request to `runRecallEvalCase()`
4. returns the normalized JSON result

HTTP status behavior is intentionally narrow:

- boundary validation failures return HTTP `400`
- unexpected adapter failures return HTTP `500`
- app-layer execution results, including app-layer error envelopes, return HTTP `200`

That last point matters. If sandbox setup, fixture provisioning, or recall execution fails inside `runRecallEvalCase()`, the route still returns `200` with `status: "error"` because the app-layer contract completed successfully.

### 3. Sandbox setup

Each eval case runs against isolated storage created by `setupRecallEvalSandbox()`.

Current sandbox behavior:

- if `sandbox.root` is supplied, it is resolved to an absolute path and reused
- otherwise a temp directory is created under the OS temp directory with the prefix `agenr-recall-eval-`
- the database path is always `<root>/knowledge.db`
- any existing `knowledge.db`, `knowledge.db-wal`, and `knowledge.db-shm` files are removed before the database opens
- when `sandbox.corpusSeed.mode` is `"snapshot_copy"`, the source snapshot DB is copied into `<root>/knowledge.db` before it is opened, which seeds the sandbox with a production-like corpus while leaving the source snapshot untouched

Cleanup depends on the request:

- if `preserve: true`, the sandbox stays on disk
- if `preserve: false` and the root was supplied, cleanup deletes only the database files
- if `preserve: false` and the root was generated, cleanup removes the whole temp directory

#### Corpus seeding

The optional `sandbox.corpusSeed` block selects how the sandbox is seeded before `memoryPool` and `procedurePool` overlays apply:

```json
{
  "sandbox": {
    "root": "/tmp/agenr-eval-case",
    "preserve": false,
    "corpusSeed": {
      "mode": "snapshot_copy",
      "snapshotDbPath": "/path/to/knowledge-snapshot.db",
      "snapshotId": "2026-04-18-nightly",
      "snapshotLabel": "nightly corpus snapshot",
      "allowTelemetryWrites": false
    }
  }
}
```

Rules:

- if `corpusSeed` is omitted, the sandbox keeps the historical fixture-only behavior
- `mode: "fixture"` is the explicit form of fixture-only seeding and behaves exactly like omitting the field
- `mode: "snapshot_copy"` copies `snapshotDbPath` into the sandbox before opening it
- `snapshotDbPath` must be a non-empty string and must resolve to an accessible file; the source DB is never opened, only copied
- `snapshotDbPath` must not resolve to the same path as the sandbox database
- `snapshotId` and `snapshotLabel` are optional provenance hints and are echoed in the response under `sandbox.snapshot`
- `allowTelemetryWrites` defaults to `false`. When `false`, the recall seam wraps the recall ports so `recordRecallEvents` becomes a no-op and the copied snapshot stays read-only-like at the telemetry layer. When `true`, normal recall telemetry writes run against the copied snapshot (never against the source)
- `memoryPool` and `procedurePool` overlays still run on top of the copied snapshot so harnesses can inject scenario-specific fixtures

Safety rules:

- the source snapshot file is never opened as a database
- all writes, when they happen, hit the copied sandbox DB
- snapshot copying is adapter-owned filesystem work driven from the app layer; `src/core/` still has zero filesystem dependencies

Successful responses include snapshot metadata under `sandbox.snapshot` when the case used `snapshot_copy`:

- `sandbox.snapshot.id` - optional echoed `snapshotId`
- `sandbox.snapshot.label` - optional echoed `snapshotLabel`
- `sandbox.snapshot.dbPathBasename` - base filename of the source snapshot (never a full path)
- `sandbox.snapshot.allowedTelemetryWrites` - whether recall telemetry writes ran against the copied snapshot

### 4. Exact fixture provisioning

If `memoryPool` is non-empty, `provisionRecallEvalFixtures()` seeds fixtures directly into isolated storage.

This path intentionally bypasses the normal store pipeline so the eval harness can preserve fixture truth:

- explicit IDs stay as given
- explicit timestamps stay as given
- retirement metadata stays as given
- supersession metadata stays as given

Current provisioning behavior:

1. resolve fixture IDs, generating deterministic IDs when omitted
2. validate that IDs are unique
3. validate that `superseded_by` points at another fixture ID
4. build canonical `Entry` rows with storage defaults
5. topologically sort fixtures so successor rows are inserted before superseded rows
6. compose embedding text for each fixture
7. embed the whole batch
8. insert entries inside one transaction

Defaulting and normalization details:

- generated IDs look like `eval-<24 hex chars>`
- `importance` defaults to `6`
- `expiry` defaults to `permanent`
- `created_at` defaults to the case provisioning timestamp
- `updated_at` defaults to `created_at`
- `quality_score` is set to `0.5`
- `recall_count` starts at `0`
- content hashes are derived from `type`, `subject`, and `content`

Important failure cases:

- duplicate fixture IDs
- unknown `superseded_by` targets
- supersession cycles
- embedding count mismatches

### 5. Real recall execution

After sandbox setup and fixture seeding, the app service executes real `agenr` recall behavior.

Shared runtime behavior:

- the app service reads config through `readConfig()`
- it resolves the embedding API key and embedding model through the normal embedding adapter helpers
- it creates real recall ports against the isolated sandbox database
- there is no eval-specific retrieval or ranking logic

#### Core path

When `recallPath` is omitted or set to `"core"`, the app service calls the normal `core/recall` pipeline.

That path uses:

- real query embeddings
- real vector search and lexical retrieval
- real merge, score, threshold, budget, and hydration behavior
- normal recall telemetry writes

#### Unified path

When `recallPath: "unified"`, the app service calls `runUnifiedRecall()` from [src/app/recall/unified.ts](../src/app/recall/unified.ts).

Important unified-path behavior:

- the unified router may query procedures, entries, episodes, or a supported combination internally
- the eval response still returns only `result.entries` and `result.entryIds`
- procedure and episode results are not surfaced in the top-level eval `result`
- unified routing metadata is surfaced in `metadata.unified`

## Diagnostics and timings

When diagnostics or timings are requested, the app layer enables observation in two places:

- `createInstrumentedRecallPorts()` wraps the real ports to collect adapter-boundary timings and counts
- `RecallTraceSink` receives a typed summary from the recall core

When diagnostics are included, the response can contain:

- `diagnostics.execution`
- `diagnostics.provision`
- `diagnostics.retrieval`
- `diagnostics.ranking`
- `diagnostics.filtering`
- `diagnostics.claimKey`
- `diagnostics.rrf`
- `diagnostics.neighborhood`
- `diagnostics.mmr`
- `diagnostics.crossEncoder`
- `diagnostics.degraded`
- `diagnostics.candidateCounts`

Current guarantees:

- `diagnostics.execution` is always present when diagnostics are returned
- `diagnostics.candidateCounts` is always present when diagnostics are returned
- `diagnostics.provision` appears only after successful provisioning
- `diagnostics.retrieval` appears only after retrieval-stage observation occurs
- `diagnostics.ranking` and `diagnostics.filtering` appear only after the core trace summary is emitted
- `diagnostics.degraded` appears only after the core trace summary is emitted
- `diagnostics.rrf`, `diagnostics.neighborhood`, `diagnostics.mmr`, and `diagnostics.crossEncoder` appear alongside `diagnostics.ranking`

Each ranking-stage branch mirrors the core `RecallExecutionTraceSummary`:

- `diagnostics.rrf` reports `{ applied, channelCount, rankConstant, fusedCandidateCount, maxFusedScore }` so harnesses can assert channel fusion actually ran and ran with the expected rank constant
- `diagnostics.neighborhood` reports `{ expansionRequested, expansionFamilies, expandedCandidateCount, strongSeedCount, strongSeedIds, rerankBoostedIds }` so harnesses can separate historical-state expansion from seeded rerank
- `diagnostics.mmr` reports `{ applied, lambda, droppedDuplicateCount, reorderedIds }` so harnesses can verify diversification kicked in and that near-duplicate candidates were suppressed
- `diagnostics.crossEncoder` reports `{ applied, k, alpha, rerankLatencyMs, reshapedIds, degradedReason? }` so harnesses can isolate cross-encoder effects and detect stage-level degradation separately from the overall degraded envelope. When `rankingPolicy.crossEncoder` is `"disabled"`, `degradedReason` is `"disabled"`; when no cross-encoder port is wired, `degradedReason` is `"not_configured"`.

`diagnostics.degraded` is the stable place to assert:

- whether recall fell back away from the normal vector-backed path
- the degraded causes such as `query_embedding_failed` or `vector_search_failed`
- whether the run became lexical-only
- the exact user-facing degraded notices returned by the product surface

`includeCandidates` remains intentionally narrow:

- it does not authorize raw candidate dumps
- it does not return candidate snapshots
- it only enables the same aggregate diagnostics the harness needs for machine-readable evals

`faultInjection` is also intentionally narrow:

- `queryEmbeddingFailure` forces the recall query embedding step to fail after fixture seeding has already succeeded
- `vectorSearchFailure` forces vector retrieval to fail after query embedding succeeds
- these hooks exist only so `agenr-evals` can carry deterministic degraded-mode corpora through the real HTTP seam
- the degraded response still comes from the normal recall codepath, so notices, no-result reasons, and lexical fallback behavior stay product-faithful

When timings are included, the response can contain:

- `totalMs`
- `sandboxSetupMs`
- `fixtureProvisionMs`
- `recallMs`
- `queryEmbeddingMs`
- `vectorSearchMs`
- `lexicalSearchMs`
- `mergeCandidatesMs`
- `scoreCandidatesMs`
- `thresholdMs`
- `budgetMs`
- `hydrateEntriesMs`
- `shapeResultsMs`
- `recordRecallEventsMs`

## Response contract

The app-layer response type is `RecallEvalCaseResponse`.

Top-level fields are intentionally bounded:

- `status`
- `caseId`
- `result`
- `metadata`
- `diagnostics`
- `timings`
- `sandbox`
- `error`

### Success responses

Successful responses include:

- `status: "ok"`
- `caseId`
- `result.entries`
- `result.entryIds`
- `metadata`
- `sandbox`
- optional `diagnostics`
- optional `timings`

Each result entry includes:

- `id`
- `subject`
- `content`
- `type`
- `importance`
- `expiry`
- `tags`
- `created_at`
- `score`
- `scores`
- optional `claim` projection with family key, memory-state label, claim-status label, freshness, provenance, and `whySurfaced`

`metadata` is the stable place for product-surface facts that the harness should assert on separately from execution diagnostics.

Current `metadata` fields:

- `path`
- `claim.projectedEntries`
- `claim.entryFamilies` for unified-path cases
- `claim.transitions` for unified-path cases
- `unified.routing` for unified-path cases
- `unified.timeWindow` when unified recall resolved one
- `unified.asOf` when unified recall echoed one
- `unified.procedure` when unified recall returned a canonical procedure
- `unified.procedureCandidates` when procedures were queried
- `unified.procedureNotices` when the procedure path emitted notices
- `unified.notices`
- `unified.episodeCount`

### Error responses

App-layer failures map to these stable error codes:

- `sandbox_setup_failed`
- `fixture_provision_failed`
- `recall_execution_failed`
- `internal_error`

Boundary-level route failures use:

- `invalid_request`
- `internal_error`

The error envelope stays small:

- `status: "error"`
- `caseId` when available
- `error.code`
- `error.message`
- optional `error.details`
- optional `diagnostics`
- optional `timings`
- optional `sandbox`

## Seeded state vs post-recall state

One subtle runtime detail matters when `sandbox.preserve` is true.

The preserved sandbox database reflects post-execution state, not just seeded fixture state.

That matters because the real recall path still performs normal telemetry updates on returned entries, such as:

- `recall_count`
- `last_recalled_at`
- `updated_at`

If you need the exact fixture truth that existed before recall mutated anything, use:

- `diagnostics.provision.seededEntries`

not the preserved on-disk database after the request has already run.

## Local `agenr-evals` loop

The intended local flow is:

```bash
cd /path/to/agenr
pnpm internal:eval-server
```

Then from `agenr-evals`:

```bash
cd /path/to/agenr-evals
./bin/evals run --manifest agenr-recall-http --adapter agenr-recall-http
```

That manifest exists today at `manifests/agenr-recall-http.json` in the `agenr-evals` repo and points at the shared internal eval server's recall route.

If you override the local server URL, point `agenr-evals` at it with:

```bash
cd /path/to/agenr-evals
AGENR_EVALS_AGENR_BASE_URL=http://127.0.0.1:4010 ./bin/evals run --manifest agenr-recall-http --adapter agenr-recall-http
```

`agenr-evals` also carries more focused manifests under `manifests/initial-recall-corpus/` and `manifests/memory-freshness/`, but they still run through the same `agenr-recall-http` adapter and the same `POST /internal/evals/recall/run` seam.

## Config relevant to evals

A minimal eval-relevant config looks like this:

```json
{
  "auth": "openai-api-key",
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "credentials": {
    "openaiApiKey": "<OpenAI API key>"
  },
  "embeddingModel": "text-embedding-3-small"
}
```

Important notes:

- evals need embedding access both for fixture seeding and for the recall query
- embeddings use `credentials.openaiApiKey`, then `OPENAI_API_KEY`
- if extraction auth is Anthropic or OpenAI subscription auth, `credentials.openaiApiKey` still needs to hold an OpenAI API key for embeddings
- `embeddingModel` falls back to `text-embedding-3-small`
- `AGENR_CONFIG_PATH` overrides the config file location
- the normal configured `dbPath` is not used for case execution because each eval case creates its own isolated sandbox database
- the eval server also resolves an OpenAI cross-encoder port at startup to exercise the phase-4 rerank stage; see the next section for the exact rules

## Cross-encoder Wiring Through The Eval Seam

The internal eval HTTP seam resolves an OpenAI-backed cross-encoder port
at server startup and forwards it to both the recall and before-turn
routes. This makes the phase-4 rerank stage observable through
`agenr-evals` without any harness-side changes, regardless of which
route an individual case hits.

Behavior:

- `startInternalEvalServer` calls `resolveCrossEncoderApiKey(config)` and
  `createOpenAICrossEncoder({ apiKey, model: resolveModel(config, "cross_encoder").modelId })`
- The credential search order mirrors embeddings:
  `config.credentials.openaiApiKey`, then `OPENAI_API_KEY`
- The cross-encoder model is driven by `config.crossEncoderModel` through
  `resolveModel(config, "cross_encoder")`, with the adapter fallback
  baked into `createOpenAICrossEncoder`
- The construction is best-effort. Any resolution failure leaves the
  port undefined so recall execution keeps working

Fail-closed behavior when the key is absent:

- `server.crossEncoder.status` is `"not_configured"` on the server handle
- `src/internal-eval-server.ts` prints
  `Cross-encoder disabled: OPENAI_API_KEY not configured.`
- Every recall case records
  `diagnostics.crossEncoder.applied = false` and
  `diagnostics.crossEncoder.degradedReason = "not_configured"`
- Every before-turn case records the same degraded trace on
  `diagnostics.durableRecallTrace.crossEncoder` because the durable
  recall stage of before-turn runs through the same core `recall`
  helper
- All existing recall manifests (`agenr-recall-http`,
  `agenr-recall-http-initial-corpus`, the claim-centric, degraded,
  memory-freshness, and temporal-slot-policy manifests) keep producing
  the same response shape; only the `crossEncoder` trace branch
  degrades to `not_configured`

When the key resolves:

- `server.crossEncoder.status` is `"configured"`
- `src/internal-eval-server.ts` prints
  `Cross-encoder enabled: OpenAI credential resolved at startup.`
- `diagnostics.crossEncoder.applied` becomes `true` on recall cases
  whose retrieved pool exercises the rerank stage and whose
  `rankingPolicy.crossEncoder` is not `"disabled"`
- `diagnostics.durableRecallTrace.crossEncoder.applied` becomes `true`
  on before-turn cases under the same conditions
- `diagnostics.crossEncoder.degradedReason` is absent on successful
  reranks and becomes `"disabled"`, `"provider_error"`, or
  `"no_candidates"` on the explicit degraded paths

Practical implications for harness authors:

- Harnesses that want to A/B the rerank should send
  `rankingPolicy.crossEncoder = "disabled"` rather than unsetting
  `OPENAI_API_KEY`, because the global key also gates embeddings
- Harnesses that want to gauge cross-encoder latency should read
  `diagnostics.crossEncoder.rerankLatencyMs` (or `latencyMs` in the core
  trace, which feeds the diagnostics branch)
- Running the full eval suite with the key configured costs more than
  running it with the key absent because every qualifying case now makes
  additional chat-completions calls; plan for the extra wall-clock

Eval-corpus reminder:

- The recall corpus is the decision surface for every knob tuned in the
  `recall-regression-resolution` plan. If production traffic exercises
  patterns the corpus does not cover, cross-encoder (and MMR, and RRF)
  defaults can overfit to the corpus. Track this explicitly when
  interpreting aggregate pass rates.

## Good files to read before changing evals

- [src/internal-recall-eval-server.ts](../src/internal-recall-eval-server.ts)
- [src/adapters/api/internal-recall-eval-server.ts](../src/adapters/api/internal-recall-eval-server.ts)
- [src/adapters/api/routes/internal-recall-eval.ts](../src/adapters/api/routes/internal-recall-eval.ts)
- [src/adapters/api/validation/recall-eval-request.ts](../src/adapters/api/validation/recall-eval-request.ts)
- [src/app/evals/recall/contracts.ts](../src/app/evals/recall/contracts.ts)
- [src/app/evals/recall/run-recall-eval-case.ts](../src/app/evals/recall/run-recall-eval-case.ts)
- [src/app/evals/recall/sandbox.ts](../src/app/evals/recall/sandbox.ts)
- [src/app/evals/recall/provision-fixtures.ts](../src/app/evals/recall/provision-fixtures.ts)
- [src/app/evals/recall/instrumented-recall-ports.ts](../src/app/evals/recall/instrumented-recall-ports.ts)
- [src/app/evals/recall/collect-diagnostics.ts](../src/app/evals/recall/collect-diagnostics.ts)
- [src/app/evals/recall/normalize-response.ts](../src/app/evals/recall/normalize-response.ts)
- [src/app/recall/unified.ts](../src/app/recall/unified.ts)
- [src/core/recall/index.ts](../src/core/recall/index.ts)
- [src/core/recall/trace.ts](../src/core/recall/trace.ts)
- [tests/app/evals/recall/run-recall-eval-case.test.ts](../tests/app/evals/recall/run-recall-eval-case.test.ts)
- [tests/adapters/api/routes/internal-recall-eval.test.ts](../tests/adapters/api/routes/internal-recall-eval.test.ts)
- [tests/adapters/api/validation/recall-eval-request.test.ts](../tests/adapters/api/validation/recall-eval-request.test.ts)
- [tests/adapters/api/internal-recall-eval-server.test.ts](../tests/adapters/api/internal-recall-eval-server.test.ts)
