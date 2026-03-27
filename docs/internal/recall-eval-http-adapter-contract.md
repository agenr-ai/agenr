# Recall eval HTTP adapter contract

Date: 2026-03-27

This note now captures the Phase 2 execution slice for the internal recall eval adapter in `agenr`.

## Route

- `POST /internal/evals/recall/run`
- Purpose: accept one recall eval case request, validate it at the HTTP boundary, and delegate to the app-layer `runRecallEvalCase()` service
- Scope: internal and dev-facing only

## Request contract

`RecallEvalCaseRequest` lives in [src/app/evals/recall/contracts.ts](/Users/jmartin/Code/agenr/src/app/evals/recall/contracts.ts).

Top-level fields:

- `caseId` - required string
- `description` - optional string
- `sandbox` - optional `{ root?: string; preserve?: boolean }`
- `memoryPool` - required array of explicit fixture entries
- `recallRequest` - required recall query aligned to current `RecallInput` fields
- `options` - optional diagnostic and timing flags

Fixture entries stay explicit and narrow. They align to current `EntryType` and `Expiry` values and do not add project-scoped concepts that `agenr` does not support.

## Response contract

`RecallEvalCaseResponse` also lives in [src/app/evals/recall/contracts.ts](/Users/jmartin/Code/agenr/src/app/evals/recall/contracts.ts).

Top-level fields:

- `status`
- `caseId`
- `result`
- `diagnostics`
- `timings`
- `sandbox`
- `error`

Phase 2 now executes one real recall eval case end to end behind `runRecallEvalCase()`:

- create an isolated case-local sandbox DB
- seed the request `memoryPool` directly into that isolated storage
- run the real recall path against the isolated DB
- normalize ranked recall results into the stable response envelope
- return structured app-level errors for sandbox setup, fixture provisioning, and recall execution failures

Successful responses now include real `result.entries` and `result.entryIds`. When diagnostics are requested, `diagnostics.execution` reports:

- `mode: "isolated-case"`
- `provisioning: "exact-fixture-seed"`
- fixture counts and request flags

Sandbox references now point at the actual case-local DB path used for execution. When `sandbox.preserve` is `true`, that DB remains on disk for inspection after the run.

Invalid request payloads are still rejected at the HTTP boundary with a structured `invalid_request` error response. If the request envelope exposes a confidently parseable non-empty `caseId`, that error response now echoes it for batch correlation. If the body is too malformed to parse `caseId` safely, the field is omitted.

## Fixture provisioning decision

Phase 2 defaults to **exact fixture seeding** into isolated storage.

Why that is the default:

- recall evals need stable fixture truth
- fixture IDs, timestamps, retirement fields, and supersession metadata should survive as given
- the normal store pipeline can dedup, normalize, or reshape the case pool in ways that muddy evaluation

Phase 2 therefore does **not** route eval fixtures through the normal store pipeline. The only normalization kept in this slice is the minimum needed for storage correctness and repeatability:

- synthesize a deterministic fixture ID when the request omits one
- fill omitted `created_at` and `updated_at` with the case provisioning timestamp
- derive embeddings and content hashes needed by the real storage and recall path

## What Phase 2 still does not implement

- richer recall diagnostics beyond the small execution summary
- artifact writing
- additional eval routes or eval domains
- alternate provisioning modes
- benchmark scoring, summaries, or suite orchestration

## Ownership split

- `agenr` owns the execution seam, request validation, route mapping, and the typed app-level contract
- `agenr-evals` owns manifests, suite orchestration, scoring, summaries, and artifact policy

## What remains for Phase 3

Phase 3 should build on this execution seam without widening the surface:

- add typed provisioning and retrieval diagnostics beyond the current execution summary
- add app-level timing and boundary counts around real recall port calls
- add optional sandbox-preservation diagnostics and artifact references when justified
- keep the route thin and keep artifact policy out of `core/`
