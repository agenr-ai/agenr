# agenr recall evals HTTP adapter plan

Date: 2026-03-27

## Goal

Add a clean HTTP adapter seam to `~/Code/agenr` that can be used by an external eval runner such as `~/Code/agenr-evals` to run evals against recall in `agenr`.

This plan assumes:

1. `agenr-evals` is the outer eval harness.
2. `agenr` is the system under test.
3. The first target domain is **recall**.
4. The transport boundary should be HTTP, not a new eval-specific CLI surface.
5. The real implementation should live behind the adapter as an app-level service, not inside route handlers.

## Why HTTP is the better first transport

An HTTP adapter is a better first move than an eval-only CLI seam because it:

1. avoids polluting the normal `agenr` CLI with eval-only commands
2. fits the repo's hexagonal architecture, where HTTP is already a first-class outer adapter
3. gives `agenr-evals` a stable JSON contract without importing `agenr` internals
4. keeps the transport boundary explicit while letting implementation details evolve behind it
5. creates a seam that can later support tooling beyond evals if it proves useful

The key constraint is scope: this should start as one narrow internal endpoint for recall-case execution, not as a broad public brain-management API.

## Core design principle

`agenr-evals` should own:

1. case definitions
2. manifests
3. orchestration
4. comparisons
5. artifacts
6. summaries

`agenr` should own:

1. the execution seam into real recall behavior
2. isolated test-brain provisioning hooks needed by that seam
3. stable structured outputs for eval consumption
4. backend-specific diagnostics that are useful for recall analysis

The HTTP adapter in `agenr` should therefore act as a narrow, explicit boundary between a generic eval runner and the real recall engine.

Most importantly, this should stay **clean and minimal**. It should be an adapter over real recall behavior, not a second eval framework and not a parallel recall implementation.

## Non-goals

This adapter should not:

1. turn `agenr` into a full eval framework
2. make `agenr` depend on `agenr-evals`
3. expose broad internal APIs just because evals might want them
4. embed manifest logic or scoring policy inside `agenr`
5. support every future eval domain up front
6. recreate or fork recall logic just for evals
7. accumulate eval-specific branching that obscures core recall behavior
8. add a new user-facing eval CLI command as the main transport
9. expand immediately into a generic public HTTP API for all memory operations

The first version should be scoped to recall eval execution only.

## Recommended architecture

The clean architecture here is:

1. an app-level recall eval execution service
2. an HTTP adapter over that service
3. an external runner that speaks JSON over HTTP

That means:

1. `app/` owns isolated sandbox setup, fixture provisioning, recall execution, and response normalization
2. `adapters/api/` owns HTTP routing, request validation, response encoding, and HTTP error mapping
3. `agenr-evals` talks only to the HTTP contract

The HTTP route is the transport seam. The app service is the real implementation seam.

## What the adapter should do

The first HTTP endpoint should let an external runner say, in effect:

1. provision an isolated brain state for this eval case
2. run a recall query against that isolated state
3. collect structured outputs and diagnostics
4. return a stable response envelope
5. clean up or preserve run artifacts as configured

That is the real job. Everything else is support machinery.

The adapter should be thought of as an **HTTP entry point into app-level recall eval execution**. Its purpose is to exercise the real recall path under controlled conditions so we can understand retrieval quality, ranking behavior, filtering behavior, abstention behavior, and failure modes. If a feature does not help us exercise or observe core recall cleanly, it probably does not belong in the first version.

## Boundary shape

The boundary should be a narrow internal HTTP endpoint in `agenr`, backed by a typed app service contract.

Conceptually:

```ts
runRecallEvalCase(request: RecallEvalCaseRequest): Promise<RecallEvalCaseResponse>
```

And then an HTTP layer that maps:

```text
POST /internal/evals/recall/run
```

to that service.

The exact path can change. The important part is the layering:

1. the runner sends a structured JSON case payload
2. the API adapter validates and normalizes the request
3. the app service provisions isolated state and runs real recall
4. the API adapter returns a stable JSON response

## Why the implementation should live in app/

This repo's architecture is explicit about responsibilities:

1. `core/` owns pure recall logic
2. `app/` owns orchestration across ports and adapters
3. `adapters/` translate external protocols into those calls

Recall eval execution is orchestration. It needs to create isolated state, provision fixtures, wire real adapters, run recall, and gather diagnostics. That belongs in `app/`, not `core/`, and not directly inside HTTP route handlers.

## First-version scope: recall only

Do not generalize too early.

The first implementation should support one bounded eval family:

1. provision an isolated memory pool for a case
2. run one recall request
3. return ranked recall outputs and relevant diagnostics

This is enough to let `agenr-evals` run meaningful recall evals while keeping the first seam understandable.

## Required capabilities for a recall HTTP adapter

### 1. Isolated case setup

The app service must be able to create or target an isolated brain state for a single eval case so that runs are deterministic and do not depend on the user's live memory.

This likely means:

1. create a temporary SQLite brain or sandbox root
2. provision a case-provided memory pool into that isolated state
3. ensure setup behavior is explicit and reproducible

### 2. Real recall execution

The service must run the real `agenr` recall path, not a simplified prototype.

It should be clear that the system under test is the actual recall engine.

### 3. Structured JSON output

The API must return machine-readable output with enough information for eval comparison and diagnosis.

At minimum that should include:

1. final recall results
2. normalized status
3. timing info
4. selected diagnostics
5. error details if the run fails

### 4. Deterministic case-local behavior

The service should minimize hidden environment dependencies.

That means:

1. explicit model and config inputs where needed
2. controlled environment handling
3. optional sanitization of inherited secrets or conflicting env vars
4. no silent dependence on the caller's live `agenr` state

### 5. Artifact-friendly diagnostics

The service should emit diagnostics that an external eval runner can store as artifacts.

This matters because recall failures are often not visible from the final ranked output alone.

## Proposed request contract

The exact schema can evolve, but the request should be organized around a single eval case and should reflect the real `agenr` data model.

### Conceptual request envelope

```ts
interface RecallEvalCaseRequest {
  caseId: string;
  description?: string;
  sandbox?: {
    root?: string;
    preserve?: boolean;
  };
  memoryPool: EvalFixtureEntry[];
  recallRequest: {
    text: string;
    limit?: number;
    threshold?: number;
    budget?: number;
    types?: EntryType[];
    tags?: string[];
    since?: string;
    until?: string;
    around?: string;
    aroundRadius?: number;
  };
  options?: {
    includeDiagnostics?: boolean;
    includeCandidates?: boolean;
    includeTimings?: boolean;
  };
}

interface EvalFixtureEntry {
  id?: string;
  type: EntryType;
  subject: string;
  content: string;
  importance?: number;
  expiry?: Expiry;
  tags?: string[];
  source_file?: string;
  source_context?: string;
  created_at?: string;
  updated_at?: string;
  retired?: boolean;
  retired_at?: string;
  retired_reason?: string;
  superseded_by?: string;
}
```

### Important design choices

1. The request contract should describe **what the runner wants evaluated**, not how internal `agenr` layers should be called.
2. The recall request should mirror the real `RecallInput` shape where possible.
3. The fixture schema should be explicit, not `Array<Record<string, unknown>>`.
4. Do not add unsupported concepts like `project` to the contract. `agenr` does not have project-scoped recall.

## Proposed response contract

The response must be stable and rich enough for downstream comparison.

### Conceptual response envelope

```ts
interface RecallEvalCaseResponse {
  status: "ok" | "error";
  caseId: string;
  result?: {
    entries: EvalRecallResultEntry[];
    entryIds: string[];
  };
  diagnostics?: {
    provision?: Record<string, unknown>;
    retrieval?: Record<string, unknown>;
    ranking?: Record<string, unknown>;
    filtering?: Record<string, unknown>;
    candidateCounts?: Record<string, number>;
  };
  timings?: Record<string, number>;
  sandbox?: {
    root?: string;
    dbPath?: string;
    preserved?: boolean;
  };
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

interface EvalRecallResultEntry {
  id: string;
  subject: string;
  content: string;
  type: EntryType;
  importance: number;
  expiry: Expiry;
  tags: string[];
  created_at: string;
  score: number;
  scores: {
    relevance: number;
    vector: number;
    lexical: number;
    recency: number;
    importance: number;
  };
}
```

The exact fields can change, but the response should preserve three layers of value:

1. final result for scoring
2. structured diagnostics for debugging
3. sandbox references for deeper inspection

## What diagnostics matter most for recall evals

For recall, the adapter should expose diagnostics that explain *why* a result happened.

At minimum, I would plan for:

1. how many fixture entries were provisioned
2. whether fixture setup changed the case pool
3. candidate counts at major retrieval stages
4. whether type, tag, and date filters were applied
5. any fallback path used
6. final returned entry ids
7. any abstain or no-result condition reasoning if available

This is the difference between "the eval failed" and "we can actually debug the failure."

## Fixture provisioning strategy

The adapter must have a deterministic way to load case fixtures into the isolated brain.

This deserves explicit design because eval fixtures often need behavior that differs from ordinary production ingest defaults.

### Recommendation

Default to **exact fixture seeding**, not the normal store pipeline.

Why:

1. eval cases often need stable ids and timestamps
2. eval cases may include retired or superseded entries that should still exist in storage
3. ordinary store dedup and normalization can silently change the test pool
4. exact seeding is easier to reason about when debugging failures

If later we want a separate "production-like provisioning" mode, that can be an explicit option. It should not be the default for recall evals.

## Sandbox strategy

The adapter should run eval cases against isolated brains, not the operator's live memory store.

That means the app service needs a first-class sandbox flow.

### Sandbox requirements

1. create an isolated DB or root per case or per run
2. provision the memory pool into that isolated store
3. run recall against that store only
4. optionally preserve the sandbox for debugging
5. return sandbox paths in the response when preservation is enabled

### Why this matters

Without isolation, recall evals become noisy, non-repeatable, and borderline useless.

## Internal architecture inside agenr

Inside `agenr`, this should be implemented as a thin app-level orchestration layer over existing stable internal capabilities.

A good internal structure would look roughly like:

1. request parsing and validation at the API boundary
2. isolated sandbox provisioner in `app/`
3. fixture provisioner in `app/`
4. recall execution service in `app/`
5. diagnostics collector or trace assembler in `app/`
6. response normalizer in `app/`
7. HTTP route handler in `adapters/api/`

That keeps the transport seam narrow while the implementation stays modular.

## Recommended internal module breakdown

Conceptually:

```text
src/
  app/
    evals/
      recall/
        contracts.ts
        run-recall-eval-case.ts
        sandbox.ts
        provision-fixtures.ts
        collect-diagnostics.ts
        normalize-response.ts
  adapters/
    api/
      index.ts
      routes/
        internal-recall-eval.ts
      validation/
        recall-eval-request.ts
```

The naming can change. The important thing is to stop eval support from leaking across unrelated parts of the codebase and to preserve the existing `core` / `app` / `adapters` split.

## Programmatic contract design

The app service contract should be explicit and typed even though the external consumer will use HTTP.

A good first version would support:

1. a single request object for one recall eval case
2. a single structured response object
3. structured error categories rather than thrown implementation noise
4. optional sandbox preservation controls
5. optional diagnostic depth controls

The HTTP adapter should call a stable app service. The external runner should not need to scrape logs or route through the normal user CLI.

## Validation strategy

Validation should happen at the HTTP seam and fail clearly.

Validation should cover:

1. required top-level fields
2. valid fixture entry shape
3. valid recall request shape
4. unsupported option combinations
5. impossible sandbox settings

Bad case input should produce structured errors, not leaked internal stack noise.

## Error model

The adapter needs a small, predictable error model.

Suggested error categories:

1. `invalid_request`
2. `sandbox_setup_failed`
3. `fixture_provision_failed`
4. `recall_execution_failed`
5. `internal_error`

This will make external runners much easier to implement and debug.

## Diagnostics and trace design

The current recall path returns ranked outputs and score breakdowns, but richer eval diagnostics will likely require explicit trace collection.

That means the implementation should decide early whether to:

1. add optional trace hooks to the recall execution path
2. collect stage counts in the app service around existing calls
3. return only diagnostics that are actually stable enough to support

The first version should be honest about guaranteed diagnostics versus best-effort diagnostics.

## Exposure model

This should start as an **internal or dev-only HTTP surface**, not as a polished public API.

That means:

1. clear path naming such as `/internal/...`
2. no commitment yet to broader public API stability beyond the eval use case
3. documentation that frames it as an internal execution seam for `agenr-evals`

If it later proves broadly useful, we can promote or reshape it. The first version should optimize for clean architecture and fast iteration.

## Phase plan

### Phase 1: define the contract

Goal: freeze the first useful HTTP contract and app service contract before wiring implementation details.

Tasks:

1. write the request schema for a recall eval case
2. write the response schema
3. decide the HTTP route shape and status-code rules
4. decide which diagnostics are guaranteed versus optional
5. document sandbox behavior

Exit criteria:

- there is a written contract that `agenr-evals` could target
- the contract is clearly recall-scoped and JSON-first
- the transport is HTTP, not a new eval CLI surface

### Phase 2: build isolated case execution

Goal: make `agenr` able to execute one recall eval case end-to-end through the app service.

Tasks:

1. implement isolated sandbox creation
2. implement exact fixture provisioning
3. call the real recall path against the isolated state
4. normalize the result into the response envelope
5. add structured error handling

Exit criteria:

- one case can be submitted over HTTP and return valid response JSON
- the case runs against isolated memory, not live memory

### Phase 3: add diagnostics and artifact hooks

Goal: make failures explainable.

Tasks:

1. add fixture provisioning diagnostics
2. add retrieval and ranking diagnostics where practical
3. include timings
4. support sandbox preservation for debugging
5. return stable artifact references when available

Exit criteria:

- failed recall cases are diagnosable without instrumenting code ad hoc
- external runner can store returned diagnostics as artifacts

### Phase 4: harden the HTTP seam

Goal: make the adapter safe to depend on from `agenr-evals`.

Tasks:

1. add schema validation tests
2. add golden tests for request and response shapes
3. add integration tests for isolated case execution over HTTP
4. remove incidental coupling to CLI-oriented assumptions
5. document the adapter contract in internal docs

Exit criteria:

- the HTTP seam is stable enough for an external runner to call
- contract behavior is test-covered

## Testing strategy

The adapter needs tests at three levels.

### 1. Contract tests

Verify:

1. valid requests succeed
2. invalid requests fail with structured errors
3. JSON response shape is stable

### 2. Sandbox integration tests

Verify:

1. isolated DB creation works
2. fixture provisioning populates the expected candidate pool
3. case runs do not leak into each other
4. preserved sandboxes contain expected files

### 3. HTTP adapter tests

Verify:

1. the route validates and maps requests correctly
2. app-service errors map to stable HTTP responses
3. JSON encoding stays stable

### 4. Recall behavior smoke tests

Verify:

1. the adapter actually calls real recall
2. expected entries can be returned from a simple fixture pool
3. empty or abstain-like scenarios are surfaced correctly
4. diagnostics remain populated in success and failure cases

## Guardrails

To keep this adapter clean:

1. do not expose random internal helper functions as public eval APIs
2. do not make `agenr-evals` import internal `agenr` modules
3. do not encode external scoring policy in `agenr`
4. do not rely on human-readable logs as the contract
5. do not widen the scope to other eval families until recall is solid
6. do not add eval-only recall behavior that differs from normal core recall unless the difference is strictly about isolation or observability
7. do not let route handlers become the place where recall experimentation logic lives
8. keep the adapter as a thin transport layer over app-level execution
9. keep the first HTTP surface narrow and internal

## Definition of done

This plan is successful when `~/Code/agenr` contains a documented, testable recall eval HTTP adapter seam that:

1. accepts a structured recall eval case request over HTTP
2. provisions an isolated case-local brain
3. runs real recall against that isolated state
4. returns stable structured results and diagnostics
5. can be called cleanly by an external runner like `~/Code/agenr-evals` without depending on the normal user CLI

## Recommended first deliverables

The first bounded implementation slice should produce:

1. an internal design doc for the recall eval HTTP contract
2. request and response TypeScript types for the app service
3. an app-level `runRecallEvalCase` service
4. isolated sandbox creation and exact fixture provisioning
5. a narrow internal HTTP route for one recall eval case
6. JSON response normalization
7. one end-to-end integration test proving an external runner could use it over HTTP

## Bottom line

The right way to add eval support to `agenr` is not to add an eval-specific CLI surface and not to spread eval logic broadly across the codebase. It is to create one narrow, explicit, JSON-first HTTP adapter seam over an app-level recall eval service.

If that seam is clean, `agenr-evals` can stay generic, `agenr` can keep evolving internally, and the CLI stays focused on real user workflows rather than eval transport.
