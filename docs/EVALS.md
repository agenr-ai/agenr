# Evals

`agenr` currently exposes one eval seam: a narrow internal recall-eval HTTP adapter used to exercise the real recall pipeline against isolated case-local state.

It exists so an external runner such as `agenr-evals` can provision explicit fixtures, execute one real recall request, and collect small typed diagnostics without turning `agenr` into a general eval platform.

This document describes the code as it exists now, not just the intended flow.

## Code map

- `package.json` - `internal:recall-eval-server` script for local hosting.
- `src/internal-recall-eval-server.ts` - dev-only entry point that starts the local server and handles shutdown.
- `src/adapters/api/internal-recall-eval-server.ts` - tiny Node HTTP server that exposes exactly one internal route.
- `src/adapters/api/routes/internal-recall-eval.ts` - thin `POST /internal/evals/recall/run` route and boundary error mapping.
- `src/adapters/api/validation/recall-eval-request.ts` - strict JSON request validation and unexpected-field rejection.
- `src/app/evals/recall/contracts.ts` - stable request, response, diagnostics, timing, and sandbox contract types.
- `src/app/evals/recall/run-recall-eval-case.ts` - top-level app service that orchestrates sandbox setup, fixture seeding, recall, and response shaping.
- `src/app/evals/recall/sandbox.ts` - isolated sandbox directory and case-local SQLite database lifecycle.
- `src/app/evals/recall/provision-fixtures.ts` - exact fixture seeding into isolated storage, including ID synthesis and embedding generation.
- `src/app/evals/recall/instrumented-recall-ports.ts` - wrappers around real recall ports to collect app-level timings and counts.
- `src/app/evals/recall/collect-diagnostics.ts` - diagnostics collector that merges app-level observations with the core trace summary.
- `src/app/evals/recall/normalize-response.ts` - stable success and error envelope shaping.
- `src/core/recall/index.ts` and `src/core/recall/trace.ts` - the real recall algorithm plus the optional typed trace sink used by evals.
- `tests/app/evals/recall/*.test.ts` and `tests/adapters/api/*.test.ts` - coverage for app orchestration, request validation, route behavior, and local server behavior.

## Important architectural nuance

The eval surface is intentionally narrower than the normal CLI commands:

- one eval domain: recall
- one case shape: one request in, one response out
- one transport: one internal HTTP route
- one app service behind that route
- one provisioning mode: exact fixture seeding into isolated storage

That split is deliberate:

- `core/` still owns real recall behavior
- `app/evals/recall/` owns sandbox setup, exact fixture provisioning, diagnostics assembly, and response normalization
- `adapters/api/` owns JSON parsing, request validation, and HTTP mapping
- `agenr-evals` or another external harness owns manifests, suite orchestration, scoring, summaries, and reporting

Current explicit non-goals:

- no public eval API surface
- no eval CLI command in the normal `agenr` CLI
- no suite orchestration inside `agenr`
- no benchmark scoring or pass/fail policy inside `agenr`
- no trace-file or candidate-snapshot artifact system
- no alternate recall behavior just for evals

## Surface

There is no user-facing `agenr eval ...` CLI command.

The current developer surface is:

```bash
pnpm internal:recall-eval-server
```

That helper builds the repo and starts a local-only HTTP server exposing:

```txt
POST /internal/evals/recall/run
```

Defaults:

- host: `127.0.0.1`
- port: `4010`

Optional overrides:

- `AGENR_INTERNAL_RECALL_EVAL_HOST`
- `AGENR_INTERNAL_RECALL_EVAL_PORT`

Server behavior is intentionally tiny:

- only the one recall-eval route exists
- any other path returns `404 Not found.`
- any other method on the route returns `405` with `Allow: POST`

## Request contract

The request type is `RecallEvalCaseRequest` from `src/app/evals/recall/contracts.ts`.

Top-level shape:

```json
{
  "caseId": "case-123",
  "description": "optional human-readable note",
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
  "options": {
    "includeDiagnostics": true,
    "includeCandidates": true,
    "includeTimings": true
  }
}
```

Important request semantics:

- `caseId` is required and echoed back on successful app-level responses.
- `description` is optional and currently informational only.
- `sandbox` is optional and controls where the isolated case DB lives and whether it is preserved.
- `memoryPool` is required and is an explicit fixture array, not an ingest path.
- `recallRequest` is required and aligns directly to the live `RecallInput` fields used by core recall.
- `options.includeDiagnostics` requests typed diagnostics.
- `options.includeCandidates` does not return raw candidates - it only requests stable aggregate diagnostics.
- `options.includeTimings` requests stage timings.

### Fixture entry rules

Each `memoryPool` item is explicit and narrow. Supported fields are:

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

Validation details that matter:

- `type` must be one of the real `EntryType` values
- `expiry` must be one of the real `Expiry` values
- `importance` must be an integer from `1-10`
- timestamps must be parseable by `Date.parse(...)`
- `tags` must be a string array
- there is no project or platform field because `agenr` does not support those concepts

### Recall request rules

Supported `recallRequest` fields are:

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

Validation details:

- `text` must be a non-empty string
- `limit` and `budget` must be non-negative integers
- `threshold` must be a number from `0-1`
- `aroundRadius` must be a positive integer
- `types` must be valid entry types
- `tags` must be a string array

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

`pnpm internal:recall-eval-server` runs `pnpm build` first, then launches `dist/internal-recall-eval-server.js`.

The runtime entry point:

- resolves host and port from environment
- starts the tiny Node HTTP server
- prints the bound base URL plus route path
- installs `SIGINT` and `SIGTERM` handlers for graceful shutdown

### 2. HTTP boundary validation

`createInternalRecallEvalRoute()` does the following:

1. parse the request body as JSON
2. validate and normalize it through `parseRecallEvalCaseRequest()`
3. delegate the typed request to `runRecallEvalCase()`
4. return the normalized JSON result

Boundary error behavior:

- malformed JSON becomes `invalid_request`
- validation failures become `invalid_request`
- unexpected route-level failures become `internal_error`
- route-level `internal_error` responses echo the validated `caseId` when validation already succeeded

### 3. Sandbox setup

Each eval case runs against isolated storage created by `setupRecallEvalSandbox()`.

Current sandbox behavior:

- if `sandbox.root` is supplied, it is resolved and reused
- otherwise a temp directory is created under the OS temp directory using the prefix `agenr-recall-eval-`
- the case database path is always `<root>/knowledge.db`
- any existing `knowledge.db`, `knowledge.db-wal`, and `knowledge.db-shm` files are removed before opening the database

Cleanup behavior depends on the request:

- if `preserve: true`, the sandbox DB remains on disk
- if `preserve: false` and the root was supplied, cleanup deletes only the DB files
- if `preserve: false` and the root was generated, cleanup removes the whole temp directory

### 4. Exact fixture provisioning

If `memoryPool` is non-empty, `provisionRecallEvalFixtures()` seeds those fixtures directly into isolated storage.

This path intentionally bypasses the normal store pipeline so the eval harness can preserve fixture truth:

- explicit IDs stay as given
- explicit timestamps stay as given
- retirement metadata stays as given
- supersession metadata stays as given

Current provisioning behavior:

1. resolve fixture IDs, generating deterministic IDs when omitted
2. validate that IDs are unique
3. validate that any `superseded_by` reference points at another fixture ID
4. build canonical `Entry` rows with storage defaults
5. topologically sort fixtures so successors are inserted before superseded entries
6. compose embedding text for each fixture
7. embed the whole batch
8. insert entries in one transaction

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

After sandbox setup and fixture seeding, the app service executes the real recall pipeline.

Current runtime behavior:

- the app service reads config via `readConfig()`
- it resolves the embedding API key and embedding model through the normal adapter helpers
- it creates the normal libSQL recall adapter against the isolated sandbox database
- it calls the same `core/recall` pipeline used by the CLI

There is no eval-specific retrieval or ranking logic.

That means the eval path still uses:

- real query embedding
- real vector search and FTS retrieval
- real merge, score, threshold, budget, and hydration behavior
- normal recall telemetry writes

The only eval-specific additions are observation and response shaping.

### 6. Diagnostics and timing collection

When diagnostics or timings are requested, the app layer enables observation in two places:

- `createInstrumentedRecallPorts()` wraps the real recall ports to collect stage timings and counts at adapter boundaries
- `RecallTraceSink` receives one small typed summary from the recall core

#### Diagnostics sections

When `includeDiagnostics` or `includeCandidates` is true, the response may include:

- `diagnostics.execution` - mode, provisioning mode, memory-pool count, provisioned count, and requested flags
- `diagnostics.provision` - exact-seed facts captured before recall telemetry can mutate rows
- `diagnostics.retrieval` - query embedding dimensions and effective vector and lexical candidate limits
- `diagnostics.ranking` - normalized `limit`, `threshold`, `budget`, and a stable no-result reason when present
- `diagnostics.filtering` - active type, tag, date, and around-date filters actually applied
- `diagnostics.candidateCounts` - vector, lexical, merged, thresholded, budgeted, ranked, hydrated, returned, and telemetry-attempted counts

Observation guarantees:

- `diagnostics.execution` is present whenever diagnostics are returned
- `diagnostics.candidateCounts` is always present when diagnostics are returned
- `diagnostics.provision` is present only after successful provisioning
- `diagnostics.retrieval`, `diagnostics.ranking`, and `diagnostics.filtering` are best-effort based on how far execution progressed

#### Timing sections

When `includeTimings` is true, the response may include:

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

`includeCandidates` is intentionally narrow:

- it does not authorize raw candidate dumps
- it does not return candidate snapshots
- it only enables the same small aggregate diagnostics needed for machine-readable evals

### 7. Response contract

The app-layer response type is `RecallEvalCaseResponse`.

Top-level sections are intentionally bounded:

- `status`
- `caseId`
- `result`
- `diagnostics`
- `timings`
- `sandbox`
- `error`

#### Success responses

Successful responses include:

- `status: "ok"`
- `caseId`
- `result.entries` with ranked entry payloads
- `result.entryIds` as a convenience list of ranked IDs
- optional diagnostics, timings, and sandbox references

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

#### Error responses

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
- optional diagnostics, timings, and sandbox references collected before failure

### 8. Seeded state vs post-recall state

One subtle runtime detail matters when `sandbox.preserve` is true.

The preserved sandbox DB reflects post-execution state, not just seeded fixture state.

That matters because the real recall path still performs normal telemetry updates on returned entries, such as:

- `recall_count`
- `last_recalled_at`
- `updated_at`

So the canonical record of seeded fixture truth is:

- `diagnostics.provision.seededEntries`

not the preserved on-disk DB after recall has already run.

### 9. What evals still do not do

Current omissions are deliberate:

- no fixture CRUD routes
- no suite CRUD routes
- no second eval route
- no second provisioning mode
- no eval-only memory-management API
- no trace-file output such as `trace.json`
- no candidate snapshot files
- no benchmark scoring or summary generation inside `agenr`

If the eval surface starts expanding beyond those constraints, it should get an explicit design review first.

## Local `agenr-evals` loop

The intended local flow is:

```bash
cd /Users/jmartin/Code/agenr
pnpm internal:recall-eval-server
```

Then from `agenr-evals`:

```bash
cd /Users/jmartin/Code/agenr-evals
./bin/evals run --manifest agenr-recall-http --adapter agenr-recall-http
```

If you override the server host or port in `agenr`, point `agenr-evals` at the new base URL:

```bash
cd /Users/jmartin/Code/agenr-evals
AGENR_EVALS_AGENR_BASE_URL=http://127.0.0.1:4010 ./bin/evals run --manifest agenr-recall-http --adapter agenr-recall-http
```

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
- embeddings use `credentials.openaiApiKey`, then legacy `embeddingApiKey`, then legacy `apiKey` for `openai-api-key`, then `OPENAI_API_KEY`
- if extraction auth is Anthropic or OpenAI subscription auth, `credentials.openaiApiKey` still needs to hold an OpenAI API key for embeddings
- `embeddingModel` falls back to `text-embedding-3-small`
- `AGENR_CONFIG_PATH` overrides the config file location
- the normal configured `dbPath` is not the execution database for eval cases because each case creates its own isolated sandbox DB

## Good files to read before changing evals

- `src/internal-recall-eval-server.ts`
- `src/adapters/api/internal-recall-eval-server.ts`
- `src/adapters/api/routes/internal-recall-eval.ts`
- `src/adapters/api/validation/recall-eval-request.ts`
- `src/app/evals/recall/contracts.ts`
- `src/app/evals/recall/run-recall-eval-case.ts`
- `src/app/evals/recall/sandbox.ts`
- `src/app/evals/recall/provision-fixtures.ts`
- `src/app/evals/recall/instrumented-recall-ports.ts`
- `src/app/evals/recall/collect-diagnostics.ts`
- `src/app/evals/recall/normalize-response.ts`
- `src/core/recall/index.ts`
- `src/core/recall/trace.ts`
- `tests/app/evals/recall/run-recall-eval-case.test.ts`
- `tests/adapters/api/routes/internal-recall-eval.test.ts`
- `tests/adapters/api/validation/recall-eval-request.test.ts`
- `tests/adapters/api/internal-recall-eval-server.test.ts`
