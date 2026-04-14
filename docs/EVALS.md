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
      "maxProcedureCandidates": 3,
      "recallThreshold": 0.25,
      "procedureThreshold": 0.7
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
- optional `timings`
- `sandbox`

Current explicit non-goals for this seam:

- no OpenClaw `before_prompt_build` eval route
- no raw candidate dumps
- no scoring, manifests, or answer-lift logic inside `agenr`

## Request contract

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
- `sandbox` is optional and controls where the isolated database lives and whether it is preserved
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

Boundary validation details:

- `text` must be a non-empty string
- `limit` and `budget` must be non-negative integers
- `threshold` must be a number from `0-1`
- `aroundRadius` must be a positive integer
- `types` must be valid entry types
- `tags` must be a string array
- `rankingProfile`, when present, must currently be `historical_state`
- `since`, `until`, and `around` are only validated as non-empty strings at the HTTP boundary today

Execution-path nuance that matters:

- on the `"core"` path, `runRecallEvalCase()` forwards the full validated `recallRequest` object to `core/recall`
- on the `"unified"` path, the seam only accepts the subset that real unified callers use today: `text`, `limit`, `threshold`, `types`, `tags`, and `asOf`
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

Cleanup depends on the request:

- if `preserve: true`, the sandbox stays on disk
- if `preserve: false` and the root was supplied, cleanup deletes only the database files
- if `preserve: false` and the root was generated, cleanup removes the whole temp directory

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
- `diagnostics.degraded`
- `diagnostics.candidateCounts`

Current guarantees:

- `diagnostics.execution` is always present when diagnostics are returned
- `diagnostics.candidateCounts` is always present when diagnostics are returned
- `diagnostics.provision` appears only after successful provisioning
- `diagnostics.retrieval` appears only after retrieval-stage observation occurs
- `diagnostics.ranking` and `diagnostics.filtering` appear only after the core trace summary is emitted
- `diagnostics.degraded` appears only after the core trace summary is emitted

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
