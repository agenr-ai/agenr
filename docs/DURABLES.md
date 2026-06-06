# Durable memory

`agenr store` is still part of the planned CLI surface, but there is no live standalone CLI command today.

The real store implementation is the shared core pipeline in `src/core/store/pipeline.ts`. The current shipped durable-memory write paths are:

- durable memory ingest via `agenr ingest durables`
- the OpenClaw `agenr_store` tool

The repo also contains claim-key scenarios that exercise the same pipeline, but those are a test/runtime seam, not the main user-facing store surface.

This document describes the code as it exists now.

## Code map

- `src/core/store/pipeline.ts` - validation, hash preparation, hash dedup, optional claim-key extraction, embedding resolution, supersession planning, and persistence
- `src/core/store/validation.ts` - store-input validation, trimming, defaults, claim-key normalization, and rejection/warning rules
- `src/core/store/hashing.ts` - exact and normalized content-hash functions
- `src/core/store/embedding-text.ts` - canonical text format used for embedding generation
- `src/core/store/claim-extraction.ts` - optional claim-key extraction used by ingest and by the store pipeline
- `src/core/claim-key-lifecycle.ts` - canonical lifecycle metadata for manual and extracted claim keys
- `src/core/types.ts` - `StoreDurableInput`, `StoreResult`, and the canonical stored `Durable` type
- `src/core/ingestion/pipeline.ts` - store-phase wrapper used by ingest bulk writes
- `src/app/ingestion/service.ts` - multi-file ingest orchestration that dedups, optionally extracts claim keys, and then stores
- `src/adapters/db/client.ts` - libSQL database adapter, including optional transaction support and bulk-write hooks
- `src/adapters/db/queries.ts` - insert SQL, exact/norm-hash lookups, claim-key sibling lookups, and supersession updates
- `src/adapters/db/schema.ts` - FTS and vector-index lifecycle used around ingest bulk writes
- `src/adapters/openclaw/tools/store.ts` - agent-facing `agenr_store` wrapper that calls the same core store pipeline
- `tests/core/store/*.test.ts` - behavior coverage for validation, hashing, claim extraction, supersession, and store-pipeline execution

## Important architectural nuance

There is still no registered `store` CLI command. `src/cli/main.ts` registers `init`, `setup`, `ingest`, `recall`, `dream`, `trace`, `db`, and `scenarios`, while `registerStoreCommand(program)` remains commented out.

That means:

- there is no current `agenr store ...` CLI surface to document
- there is a live agent-facing store surface through `agenr_store`
- the production durable-write path is `agenr ingest`
- direct non-tool callers are expected to invoke `storeDurables()` or `storeDurablesDetailed()` programmatically

Both core store entry points live in `src/core/store/pipeline.ts`:

- `storeDurablesDetailed()` returns aggregate counts plus per-input outcomes and is what ingest and the OpenClaw tool use
- `storeDurables()` is the smaller wrapper that returns only aggregate counts

## Input shape

The store pipeline accepts an array of `StoreDurableInput` values:

```ts
interface StoreDurableInput {
  type: DurableKind;
  subject: string;
  content: string;
  importance?: number;
  expiry?: "core" | "permanent" | "temporary";
  tags?: string[];
  source_file?: string;
  source_context?: string;
  user_id?: string;
  project?: string;
  created_at?: string;
  supersedes?: string;
  claim_key?: string;
  claim_key_raw?: string;
  claim_key_status?: "trusted" | "tentative" | "unresolved";
  claim_key_source?:
    | "manual"
    | "model"
    | "json_retry"
    | "deterministic_repair"
    | "dreaming_extract"
    | "dreaming_reconcile"
    | "dreaming_temporalize"
    | "dreaming_project";
  claim_key_confidence?: number;
  claim_key_rationale?: string;
  claim_support_source_kind?: string;
  claim_support_locator?: string;
  claim_support_observed_at?: string;
  claim_support_mode?: "explicit" | "normalized" | "inferred";
  valid_from?: string;
  valid_to?: string;
  directive_polarity?: "abstain" | "proactive";
  directive_trigger?: "session_start" | "always" | `topic:${string}`;
}
```

Notable properties:

- `type`, `subject`, and `content` are required
- `importance` defaults to `7` after validation
- `expiry` defaults to `temporary`
- `tags` default to `[]`
- `source_file` participates in the exact content hash
- `source_context` is stored for provenance but does not affect dedup
- `user_id` and `project` are stored when supplied, but do not affect dedup
- `created_at` is trimmed and preserved when supplied, but is not format-validated by the store validator
- `supersedes` lets a caller explicitly mark one active entry as replaced by the new stored row
- `claim_key` and its lifecycle/support fields may be supplied directly, inferred earlier by ingest, or extracted inside the store pipeline
- `valid_from` and `valid_to` are stored as temporal world-state bounds, must parse as ISO timestamps when present, and must be strictly ordered when both are supplied
- `directive_polarity` and `directive_trigger` are valid only for `type: "directive"` rows
- directive rows must use claim keys under `user/memory_directive/<name>`
- directive expiry defaults to `core`; proactive trigger defaults to `session_start`; abstain trigger defaults to `always`

Read-side Phase 3 semantics now use these clocks differently:

- `valid_from` / `valid_to` are the strongest signal for explicit `asOf` state resolution
- `claim_support_observed_at` is the next-best source/assertion-time fallback when no validity window exists
- `created_at` remains the weakest fallback clock and should not be treated as authoritative world-valid time

## Durable-memory fit

Callers should apply a durable-memory filter before writing. The store pipeline validates shape, deduplicates content, and may attach claim-key lifecycle metadata, but it does not decide whether something belongs in long-term memory.

### What belongs in durable memory

- personal facts such as allergies, relationships, communication preferences, biographical details, and standing constraints
- standing decisions and constraints about how someone wants things handled
- memory behavior directives such as topics to suppress or reminders to proactively surface
- verified system, environment, or world facts that will still matter later
- lessons grounded in a specific experience, failure, or discovery
- rare milestones and notable one-time events with durable future significance

### What does not belong

- canonical records that already live in another source of truth such as version control, ticket systems, calendars, signed documents, chat/email threads, or CRMs/databases
- records of activity whose main value is that they happened, rather than a durable takeaway future sessions should use
- progress snapshots or current-state descriptions about what is happening right now
- plans, checklists, intentions, or speculative future actions
- conversation summaries or session meta narration
- re-extracted recall material, including injected durables, episode recall, or continuity text
- generic advice that could appear in any tutorial, guide, or self-help list
- transient status, errors, troubleshooting steps, or debugging journey details

Store the durable takeaway, not the record itself.

## Runtime options

There is no CLI option surface yet, but the pipeline supports these programmatic options:

```ts
interface StoreDurablesOptions {
  dryRun?: boolean;
  verbose?: boolean;
  precomputedEmbeddings?: number[][];
  claimExtraction?: {
    llm: LlmPort;
    db: DatabasePort;
    config: ClaimExtractionConfig;
  };
  onWarning?: (warning: string) => void;
  onClaimExtractionDiagnostic?: (inputIndex: number, diagnostic: ClaimExtractionDiagnostic) => void;
}
```

- `dryRun` runs validation and dedup planning but skips claim-key extraction side effects, embedding calls, and persistence
- `verbose` exists in the option type, but the core store pipeline itself does not currently branch on it
- `precomputedEmbeddings` lets callers reuse vectors computed earlier, aligned to the original input array
- `claimExtraction` enables best-effort claim-key extraction for pending entries that do not already carry accepted lifecycle metadata
- `onWarning` receives non-fatal validation, claim-key, and supersession warnings
- `onClaimExtractionDiagnostic` exposes structured per-input extraction diagnostics when claim extraction runs

## End-to-end flow

### 1. Validation and normalization

`validateEntriesWithIndexes()` performs the first pass and preserves the original array index for each accepted input.

Current hard rejections:

- invalid `type`
- blank `subject`
- blank `content`
- invalid `expiry`
- non-`string[]` `tags`
- non-finite `importance`
- invalid `supersedes` UUID
- invalid `valid_from` timestamp
- invalid `valid_to` timestamp
- equal or reversed `valid_from` / `valid_to`
- claim-key lifecycle metadata without a valid normalized `claim_key`
- partial or invalid precomputed claim-key lifecycle bundles

Current normalization behavior:

- trims `subject` and `content`
- rounds and clamps `importance` into `1-10`
- defaults missing `importance` to `7`
- defaults missing `expiry` to `temporary`
- trims tags and drops empty tag strings
- trims `source_file`, `source_context`, `user_id`, `project`, `created_at`, `supersedes`, `valid_from`, and `valid_to`, dropping them when empty
- normalizes valid `claim_key` values to canonical `entity/attribute` form

Current warning-only behavior:

- malformed `claim_key` values are dropped instead of rejecting the entry
- invalid `claim_key_status`, `claim_key_source`, `claim_key_confidence`, `claim_support_observed_at`, and `claim_support_mode` are dropped with warnings during normalization
- if any precomputed lifecycle field is present, those warnings become part of a hard rejection unless the caller supplied a complete valid lifecycle bundle

This validator is intentionally simpler than the extraction parser:

- it does not lowercase or deduplicate tags
- it does not cap tag count
- it does not enforce a minimum content length
- it does not block meta subjects like `user` or `this session`
- it does not validate `created_at` format

Invalid inputs become `rejected` outcomes with reason `validation`.

### 2. Hash preparation and manual claim-key preparation

For every validated entry, the pipeline computes two hashes:

- `content_hash` via `computeContentHash(content, source_file)`
- `norm_content_hash` via `computeNormContentHash(content)`

The exact hash is source-aware:

- if `source_file` exists, the hash input is `${source_file}\n${content}`
- otherwise the hash input is just `content`

The normalized hash is source-agnostic and content-only:

- lowercase
- collapse whitespace to single spaces
- trim
- strip non-word punctuation

Important consequence: neither hash includes `type`, `subject`, `tags`, `importance`, `expiry`, `user_id`, `project`, temporal bounds, or claim-key metadata. Two entries with different metadata but the same content can still collide in store dedup.

During the same preparation step, the pipeline also builds accepted manual claim-key lifecycle metadata when possible:

- precomputed accepted lifecycle metadata is preserved as-is
- otherwise a normalized caller-supplied `claim_key` becomes a trusted manual claim key
- support provenance by itself does not count as a precomputed lifecycle bundle, so callers can preserve support facts for manual claim keys without inventing lifecycle semantics
- raw claim-key text and optional support metadata are preserved when available

### 3. Hash-based dedup plan

`buildStorePlan()` applies dedup in a fixed order:

1. within-batch exact `content_hash` dedup
2. exact `content_hash` dedup against the existing database
3. within-batch normalized `norm_content_hash` dedup
4. normalized `norm_content_hash` dedup against the existing database

At each stage, the first surviving entry wins and later collisions are marked `skipped`.

Database lookups only consider active entries:

- `retired = 0`
- `superseded_by IS NULL`

So retired or superseded rows do not block a new store operation.

The skip reasons are intentionally coarse:

- `content_hash`
- `norm_content_hash`

Those reasons do not tell you whether the skip happened within the current batch or because the hash already existed in the database.

### 4. Dry-run behavior

If `dryRun` is enabled, the pipeline stops after the dedup plan is built.

That means dry runs still perform:

- validation
- claim-key normalization
- hash computation
- within-batch dedup
- existing-hash database lookups

But dry runs do not perform:

- claim-key extraction
- embedding generation
- entry insertion
- explicit or automatic supersession linking

`storeDurablesDetailed()` marks pending would-be inserts as `dry_run` details. `storeDurables()` discards those details and returns only aggregate `stored`, `skipped`, and `rejected` counts.

### 5. Optional claim-key extraction

For pending entries that survive validation and dedup, the pipeline can run best-effort claim-key extraction before embedding and persistence.

Current behavior:

- this step runs only when `options.claimExtraction` is provided
- entries that already have accepted lifecycle metadata do not get reclassified
- extraction failures are non-fatal and surface through `onWarning`
- accepted extracted keys are written back onto the pending inputs through the shared lifecycle helpers

Accepted extracted claim keys can currently come from:

- `model`
- `json_retry`
- `deterministic_repair`

The extracted lifecycle metadata includes:

- canonical `claim_key`
- preserved `claim_key_raw`
- trusted/tentative status as derived by the extractor
- source and confidence
- rationale
- inferred support metadata built from the ingest/store context

### 6. Embedding resolution

For entries that survive validation and dedup:

- if `precomputedEmbeddings` is provided, the pipeline reuses those vectors by original input index
- otherwise, it calls the embedding port on the canonical embedding text

Embedding text is currently:

```txt
<type>: <subject> - <content>
```

Precomputed embeddings must match the original input array length exactly. If the array length is wrong or a survivor is missing its aligned vector, the store call throws.

If the embedding provider returns a different number of vectors than pending entries, the store call also throws.

### 7. Persistence and supersession

`persistEntries()` writes the surviving prepared entries in order.

Persistence behavior:

- each stored row gets a fresh UUID
- `created_at` uses the input value when present, otherwise `now`
- `updated_at` is always set to `now`
- `quality_score` is initialized to `0.5`
- `recall_count` is initialized to `0`
- `retired` is initialized to `false`
- `user_id`, `project`, `valid_from`, `valid_to`, `content_hash`, and `norm_content_hash` are copied through when present
- accepted claim-key lifecycle metadata is persisted when available

Explicit supersession behavior:

- if the caller supplied `supersedes`, the pipeline stores the new row first
- it then calls `db.supersedeDurable(oldId, newId, "update")`
- if the target row is missing or inactive, the new row stays stored and a warning is emitted

Automatic claim-key supersession behavior:

- runs before inserts so it only considers pre-existing active siblings, not other entries in the current batch
- requires exactly one active sibling with the same claim key
- is skipped when the current batch itself contains multiple entries for that claim key
- accepts trusted manual claim keys
- also accepts high-confidence extracted claim keys from `model` or `json_retry`
- validates supersession rules before linking, including type/expiry compatibility
- emits warnings instead of failing the store when auto-linking is unsafe or ambiguous

Transaction behavior:

- if the database adapter supports `withTransaction()`, the pipeline uses one transaction for multi-entry batches
- it also uses a transaction for single-entry writes that may perform `supersedes` or claim-key-driven supersession work
- otherwise inserts and follow-up supersession updates run sequentially without an explicit transaction wrapper

### 8. Ingest wrapper behavior

The core store pipeline itself does not manage FTS or vector-index rebuilds.

That wrapper lives in `storeExtractedResults()` inside `src/core/ingestion/pipeline.ts`. When ingest reaches the store phase and the run is not a dry run, it:

1. flattens all final survivors across files
2. calls `db.prepareForBulkWrites()`
3. runs one `storeDurablesDetailed()` call for the whole batch
4. maps per-input outcomes back to per-file store counts
5. writes ingest-log rows per file
6. calls `db.finalizeBulkWrites()`

In the libSQL adapter, that bulk-write cycle:

- records that a bulk-write phase is active in `_meta`
- drops FTS triggers
- drops vector indexes
- recreates FTS triggers
- rebuilds FTS
- recreates vector indexes
- records the last bulk-ingest timestamp in `_meta`

So the current durable-ingest path is:

1. ingest extracts entries
2. ingest optionally runs semantic dedup across the batch
3. ingest may run claim-key extraction across the dedup survivors
4. store runs validation, hash dedup, optional extraction, embedding, and persistence

That means ingest has two distinct dedup layers:

- semantic dedup in `src/core/ingestion/dedup.ts`
- hash dedup in `src/core/store/pipeline.ts`

### 9. OpenClaw tool behavior

The OpenClaw `agenr_store` tool stores one entry at a time and calls `storeDurablesDetailed()` directly without the ingest bulk-write wrapper.

Current tool-specific behavior:

- fills `source_file` from the active OpenClaw session when available
- defaults `source_context` to `Stored via agenr_store from OpenClaw.`
- accepts `supersedes`, `claimKey`, `validFrom`, and `validTo`
- attaches explicit claim-support metadata when a tool caller supplies `claimKey`
- may enable the same optional claim-key extraction path if the plugin runtime was configured with claim extraction

So the tool and ingest paths converge in the same store pipeline, but ingest adds cross-file semantic dedup and bulk-write index management around it.
