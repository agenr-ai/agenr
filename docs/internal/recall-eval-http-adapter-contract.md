# Recall eval HTTP adapter contract

Date: 2026-03-27

This note now captures the Phase 3 diagnostics slice for the internal recall eval adapter in `agenr`.

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

Phase 3 keeps the Phase 2 execution seam intact:

- create an isolated case-local sandbox DB
- seed the request `memoryPool` directly into that isolated storage
- run the real recall path against the isolated DB
- normalize ranked recall results into the stable response envelope
- return structured app-level errors for sandbox setup, fixture provisioning, and recall execution failures

Successful responses include real `result.entries` and `result.entryIds`.

When diagnostics are requested, the stable response sections are now:

- `mode: "isolated-case"`
- `provisioning: "exact-fixture-seed"`
- `diagnostics.execution` - fixture counts and request flags
- `diagnostics.provision` - exact-seed facts captured before recall telemetry can mutate rows
- `diagnostics.retrieval` - query embedding dimensions plus effective vector and lexical candidate limits
- `diagnostics.ranking` - normalized limit, threshold, budget, and a stable no-result reason when one exists
- `diagnostics.filtering` - active type, tag, date, and around-date filters actually applied
- `diagnostics.candidateCounts` - vector, lexical, merged, thresholded, budgeted, ranked, hydrated, returned, and telemetry-attempted counts
- `timings` - flat stage timings for sandbox setup, fixture provisioning, recall, query embedding, retrieval, ranking sub-stages, hydration, shaping, and telemetry

Sandbox references now point at the actual case-local DB path used for execution. When `sandbox.preserve` is `true`, that DB remains on disk for inspection after the run.

No new trace-artifact files are written in Phase 3. The only inspection references remain the existing sandbox paths in the response.

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

## Diagnostics guarantees

Guaranteed when requested:

- `diagnostics.execution`
- `diagnostics.candidateCounts`
- `timings`
- `diagnostics.provision` after successful exact fixture provisioning

Best-effort when the run reaches those stages before a failure:

- `diagnostics.retrieval`
- `diagnostics.ranking`
- `diagnostics.filtering`

The error envelope stays small and typed. Failures return the same top-level response shape and only include diagnostics that were actually collected.

## How diagnostics are collected

App-owned collection:

- sandbox setup timing
- exact fixture provisioning summary
- query embedding timing
- vector search timing and count
- lexical search timing and count
- hydrate timing and count
- telemetry timing and attempted entry count

Core-owned typed trace summary:

- active filtering summary
- normalized ranking configuration
- merged candidate count
- threshold-qualified count
- budget-accepted count
- final-ranked count
- returned count
- no-result reason
- merge, score, threshold, budget, and shape timings

The core trace seam is optional and null-object by default. It emits one typed summary only. It does not write logs, files, or artifact paths.

## Seeded state vs post-recall state

Phase 3 makes an explicit distinction between:

- seeded fixture state before recall runs
- post-execution storage state after normal recall telemetry updates rows

Important consequence:

- preserved sandbox DB contents are **post-recall state**
- `diagnostics.provision.seededEntries` is the canonical seeded-state summary

This matters because the normal recall path updates returned active rows through telemetry such as:

- `last_recalled_at`
- `updated_at`
- `recall_count`

Phase 3 does not suppress or special-case that telemetry for evals. Instead, the response exposes seeded-state facts from the provisioning step and execution facts from the live recall run so the two states are not blurred.

## Ownership split

- `agenr` owns the execution seam, request validation, route mapping, and the typed app-level contract
- `agenr-evals` owns manifests, suite orchestration, scoring, summaries, and artifact policy

## Still intentionally narrow

- one internal route
- one recall-case request and response shape
- one exact fixture-seed provisioning mode
- no eval CLI
- no suite orchestration
- no scoring or benchmark summaries
- no artifact-writing system in `core/`
- no widened memory-management API surface
