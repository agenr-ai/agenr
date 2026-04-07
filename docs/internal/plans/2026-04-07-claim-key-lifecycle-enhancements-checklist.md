# Claim-Key Lifecycle Enhancements Execution Checklist

Related plan:
- `docs/internal/plans/2026-04-07-claim-key-lifecycle-enhancements.md`

Purpose:
- turn the implementation plan into a dependency-ordered execution checklist
- make it obvious what can start now, what must wait, and what defines done

---

## Execution order at a glance

Phase A — Foundations
1. Domain types
2. DB schema + persistence plumbing

Phase B — Write path
3. Store lifecycle assignment
4. Ingest / OpenClaw preservation

Phase C — Read path
5. Recall trust-aware behavior

Phase D — Background convergence
6. Surgeon lifecycle-aware writes and proposal backlog improvements

Phase E — Visibility
7. Metrics and docs

Recommended merge strategy:
- one PR per task if you want clean review boundaries
- otherwise two stacked PRs:
  - PR 1: Tasks 1-4
  - PR 2: Tasks 5-7

---

## Critical dependency graph

Must happen first:
- Task 1 before Task 2
- Task 2 before Tasks 3, 4, 5, 6

Strongly recommended order:
- Task 3 before Task 5
- Task 3 before Task 6
- Task 4 after Task 3 or in parallel once Task 2 lands
- Task 7 last

Can run in parallel after schema lands:
- Task 4 and parts of Task 6

Should not start early:
- do not change recall trust behavior before lifecycle fields exist in DB and row mapping
- do not broaden surgeon lifecycle writes before the persistence model is in place

---

## Pre-flight checklist

- [x] Confirm the plan file is the current source of truth
- [x] Defer `claim_key_entity` and `claim_key_attribute` materialization to follow-up work after lifecycle fields land cleanly in storage
- [x] Decide the exact enum values for:
  - [x] `claim_key_status`
  - [x] `claim_key_source`
  - [x] `claim_support_mode`
- [x] Decide whether `StoreEntryInput` should expose any lifecycle fields beyond plain `claim_key`
- [x] Confirm migration strategy from current DB schema version
- [x] Confirm whether any CLI or adapter output formats need updating for new fields

Recommended defaults:
- ship `claim_key_status = trusted | tentative | unresolved`
- ship `claim_key_source = manual | model | json_retry | deterministic_repair | surgeon_metadata_rewrite | surgeon_family_reuse | surgeon_compaction`
- ship `claim_support_mode = explicit | normalized | inferred`
- keep caller-facing input minimal; let the pipeline derive lifecycle fields

---

## Task 1 — Domain types

Status gate:
- this task is done when the domain model can represent lifecycle metadata cleanly and the codebase compiles against the new types

Checklist:
- [x] Add `ClaimKeyStatus` type in `src/core/types.ts`
- [x] Add `ClaimKeySource` type in `src/core/types.ts`
- [x] Add `ClaimSupportMode` type in `src/core/types.ts`
- [x] Extend `Entry` with optional lifecycle fields:
  - [x] `claim_key_raw`
  - [x] `claim_key_status`
  - [x] `claim_key_source`
  - [x] `claim_key_confidence`
  - [x] `claim_key_rationale`
  - [x] `claim_support_source_kind`
  - [x] `claim_support_locator`
  - [x] `claim_support_observed_at`
  - [x] `claim_support_mode`
- [x] Defer `claim_key_entity` / `claim_key_attribute` materialization from Task 1 scope
- [x] Update `StoreEntryInput` only where external input is actually justified
- [x] Update `src/core/ports.ts` signatures/types as needed
- [x] Add or update focused tests for type-facing DB/client usage
- [x] Run `pnpm typecheck`
- [x] Run `pnpm test tests/adapters/db/client.test.ts`

Exit criteria:
- [x] TypeScript compiles
- [x] No adapter signatures are left inconsistent
- [x] New fields are optional and non-breaking by default

---

## Task 2 — DB schema and persistence plumbing

Status gate:
- this task is done when lifecycle fields round-trip through the DB safely on fresh and migrated databases

Checklist:
- [x] Add new `entries` columns in `src/adapters/db/schema.ts`
- [x] Add migration from current schema version
- [x] Bump schema version if required by the repo’s migration pattern
- [x] Update `insertEntry(...)` in `src/adapters/db/queries.ts`
- [x] Update select queries to fetch the new fields
- [x] Consolidate full-entry select columns used by DB adapters to avoid hydration drift
- [x] Update row mapping in `src/adapters/db/row-mapping.ts`
- [x] Confirm `src/adapters/db/client.ts` needs no new method parameters in Task 2 scope
- [x] Keep materialized entity/attribute fields deferred in Task 2 scope
- [x] Add schema migration tests
- [x] Add round-trip client tests
- [x] Run:
  - [x] `pnpm test tests/adapters/db/schema.test.ts`
  - [x] `pnpm test tests/adapters/db/client.test.ts`

Exit criteria:
- [x] Fresh DB schema includes new fields
- [x] Upgrade path works
- [x] Existing rows still hydrate with null lifecycle fields
- [x] Insert/select/update paths preserve the new values correctly

Blockers cleared for later tasks:
- [x] Store can now persist lifecycle metadata
- [x] Recall can now read lifecycle metadata
- [x] Surgeon can now write lifecycle metadata

---

## Task 3 — Store pipeline lifecycle assignment

Status gate:
- this task is done when accepted claim keys persist explicit status/source/confidence/rationale and auto-supersession is gated on trust

Checklist:
- [x] Add failing tests for manual key lifecycle assignment
- [x] Add failing tests for extracted `model` / `json_retry` lifecycle assignment
- [x] Add failing tests for `deterministic_repair` => tentative behavior
- [x] Add failing tests for compaction rationale persistence
- [x] Add failing tests for invalid manual key rejection/drop-with-warning
- [x] Refactor store-path claim-key acceptance to return structured metadata, not only a string
- [x] Persist `claim_key_raw` when raw text differs from canonical key
- [x] Set `claim_key_status` for accepted keys
- [x] Set `claim_key_source` for accepted keys
- [x] Set `claim_key_confidence` for accepted keys
- [x] Set `claim_key_rationale` for accepted keys
- [ ] If materialized fields ship now, populate `claim_key_entity` / `claim_key_attribute`
- [x] Gate `planAutoSupersession(...)` on trusted status
- [x] Keep `deterministic_repair` ineligible for auto-supersession in this phase
- [ ] Run:
  - [x] `pnpm test tests/core/store/validation.test.ts`
  - [x] `pnpm test tests/core/store/claim-extraction.test.ts`
  - [x] `pnpm test tests/core/store/pipeline.test.ts`

Exit criteria:
- [x] Manual keys land as trusted/manual/1.0
- [x] Strong extracted keys land with explicit trusted source metadata
- [x] Deterministic repair stays tentative
- [x] Auto-supersession uses lifecycle status, not only key presence

---

## Task 4 — Ingest and OpenClaw preservation

Status gate:
- this task is done when explicit claim keys seen in transcript/tool-call paths survive as high-intent manual/trusted keys with preserved raw text and basic support metadata

Checklist:
- [x] Add failing tests for explicit tool-call `claimKey` preservation
- [x] Add failing tests for malformed preserved key normalization/drop behavior
- [x] Add failing tests for support source/locator propagation when available
- [x] Update `src/core/ingestion/prompts.ts` if prompt wording needs strengthening
- [x] Update `src/core/ingestion/parser.ts` to preserve raw/manual intent cleanly
- [x] Update `src/app/ingestion/service.ts` to carry preserved claim-key metadata through store
- [x] Update `src/adapters/openclaw/tools/store.ts`
- [x] Update `src/adapters/openclaw/tools/update.ts`
- [x] Populate support fields conservatively when provenance is visible
- [x] Necessary scope additions discovered during implementation:
  - [x] Extend `StoreEntryInput` / `EntryUpdateInput` so explicit raw/support metadata can flow through ingest and direct update paths
  - [x] Update `src/core/store/validation.ts` and `src/core/store/pipeline.ts` so preserved metadata survives validation and lands in persisted lifecycle fields
  - [x] Update `src/core/ingestion/pipeline.ts` so single-file ingest and dedup do not strip explicit claim keys
  - [x] Update `src/adapters/db/queries.ts` and `tests/adapters/db/client.test.ts` so `agenr_update` can persist lifecycle/support metadata when claim keys are updated directly
- [x] Run:
  - [x] `pnpm typecheck`
  - [x] `pnpm test tests/core/ingestion/prompts.test.ts`
  - [x] `pnpm test tests/core/ingestion/parser.test.ts`
  - [x] `pnpm test tests/core/ingestion/pipeline.test.ts`
  - [x] `pnpm test tests/app/ingestion/service.test.ts`
  - [x] `pnpm test tests/adapters/openclaw/tools.test.ts`
  - [x] `pnpm test tests/adapters/db/client.test.ts`

Exit criteria:
- [x] Explicit keys are not silently degraded into inferred/tentative behavior
- [x] Preservation path matches store-path semantics for manual keys
- [x] Raw source key text is retained where useful

---

## Task 5 — Recall trust-aware behavior

Status gate:
- this task is done when recall uses claim-key lifecycle status to make historical same-slot behavior safer and less redundant

Checklist:
- [x] Add failing tests for trusted vs tentative lineage preference
- [x] Add failing tests for current-state de-dup/redundancy shaping among trusted same-slot siblings
- [x] Add failing tests for tentative same-key siblings not dominating current answers
- [x] Ensure recall candidates or hydrated entries expose needed lifecycle fields
- [x] Update `src/adapters/db/recall-adapter.ts` query/select logic if needed
- [x] Update `src/core/recall/search.ts` lineage boost logic to check trusted status
- [x] Add light result shaping to avoid flooding top results with the same trusted slot
- [x] Preserve trace/debug explainability for claim-key-driven decisions
- [x] Necessary scope additions discovered during implementation:
  - [x] Extend `RecallCandidateEntry` so ranking-time candidates carry `claim_key_status`
  - [x] Extend recall score breakdowns and trace summaries so claim-key boosts and penalties remain inspectable
- [x] Run:
  - [x] `pnpm typecheck`
  - [x] `pnpm test tests/core/recall/search.test.ts`
  - [x] `pnpm test tests/adapters/db/recall-adapter.test.ts`
  - [x] `pnpm test tests/app/recall/unified.test.ts`

Exit criteria:
- [x] Historical recall prefers trusted same-slot lineage
- [x] Tentative keys do not create aggressive collapse or misleading boosts
- [x] Result diversity improves for repeated same-slot active entries

---

## Task 6 — Surgeon lifecycle-aware writes and durable proposal backlog

Status gate:
- this task is done when surgeon repairs write lifecycle metadata and unresolved ambiguity remains durable and inspectable

Checklist:
- [ ] Add failing tests for lifecycle metadata on surgeon-applied repairs
- [ ] Add failing tests for raw/proposed key preservation in surgeon repairs
- [ ] Add failing tests for stronger proposal rationale payloads
- [ ] Update `src/app/surgeon/claim-key-quality.ts` to persist status/source/confidence/rationale on repair
- [ ] Ensure compaction/family reuse/metadata rewrite each map to explicit `claim_key_source`
- [ ] Preserve prior/proposed raw key data when known
- [ ] Update `src/core/surgeon/types.ts` if proposal/action payloads need richer fields
- [ ] Update `src/adapters/db/surgeon-run-log.ts` if proposal storage needs richer write/read behavior
- [ ] Keep `surgeon_run_proposals` as the durable backlog in this phase
- [ ] Run:
  - [ ] `pnpm test tests/app/surgeon/claim-key-quality.test.ts`
  - [ ] `pnpm test tests/adapters/db/surgeon-run-log.test.ts`
  - [ ] `pnpm test tests/adapters/db/surgeon-queries.test.ts`

Exit criteria:
- [ ] Surgeon no longer mutates only `claim_key`; it writes lifecycle state too
- [ ] Auto-applied repair provenance is inspectable later
- [ ] Ambiguous cases remain as durable proposals instead of vanishing into logs

---

## Task 7 — Metrics and docs

Status gate:
- this task is done when operators can understand the new lifecycle semantics and inspect claim-key health at a glance

Checklist:
- [ ] Decide where lifecycle policy docs live:
  - [ ] `docs/SURGEON.md`
  - [ ] dedicated internal claim-key doc
  - [ ] `README.md` if any user-facing behavior changes
- [ ] Document what claim keys mean
- [ ] Document what claim keys do not mean
- [ ] Document trusted vs tentative vs unresolved behavior
- [ ] Document when auto-supersession is allowed
- [ ] Document how surgeon proposals should be interpreted
- [ ] Add health metrics reporting for at least:
  - [ ] trusted key count
  - [ ] tentative key count
  - [ ] unresolved/no-key count
  - [ ] proposal backlog size
  - [ ] auto-supersession decisions by source/status if cheap to expose
- [ ] Update CLI tests if surgeon status/history output changes
- [ ] Run:
  - [ ] `pnpm test tests/cli/commands/surgeon.test.ts`
  - [ ] `pnpm lint`

Exit criteria:
- [ ] docs explain the lifecycle cleanly
- [ ] operator surfaces expose enough state to debug bad claim-key behavior

---

## Recommended implementation checkpoints

Checkpoint 1 — schema-ready
- [ ] Tasks 1-2 complete
- [ ] DB round-trip verified
- [ ] ready to start real behavior changes

Checkpoint 2 — write-path-ready
- [ ] Task 3 complete
- [ ] store assigns lifecycle metadata deterministically
- [ ] safe to wire preservation paths

Checkpoint 3 — ingest-safe
- [ ] Task 4 complete
- [ ] explicit keys no longer get degraded during ingest/tool flows

Checkpoint 4 — retrieval-safe
- [ ] Task 5 complete
- [ ] trust-aware recall behavior verified

Checkpoint 5 — convergence-safe
- [ ] Task 6 complete
- [ ] surgeon uses the same durable lifecycle model

Checkpoint 6 — shippable
- [ ] Task 7 complete
- [ ] docs and observability are in place
- [ ] full test suite passes

---

## Full verification checklist before merge

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] Manual sanity check: store manual key and inspect DB/result shape
- [ ] Manual sanity check: store extracted key and confirm trusted/tentative semantics
- [ ] Manual sanity check: trigger supersession candidate and confirm trusted-only gating
- [ ] Manual sanity check: run claim-key-quality surgeon pass and inspect lifecycle/proposal outputs
- [ ] Manual sanity check: run recall against same-slot historical entries and inspect ordering

---

## Things to watch while implementing

- [ ] avoid creating two different notions of “trusted” between store and surgeon
- [ ] avoid persisting weak guesses just to populate fields
- [ ] avoid making family convergence an online hard dependency too early
- [ ] avoid overgrowing enums before they drive behavior
- [ ] avoid slipping into a claim-table rewrite during this phase

---

## Suggested first execution slice

If you want the most leverage with the least churn, do this first:

1. Task 1
2. Task 2
3. Task 3

That gives you the core durable model and trusted write behavior before you touch recall or surgeon.
