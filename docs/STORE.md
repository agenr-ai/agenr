# Store

`agenr store` is part of the planned product surface, but there is no live standalone CLI command yet.

Today, the real store implementation is the core pipeline in `src/core/store/pipeline.ts`, and the current production caller is the ingest flow.

This document describes the code as it exists now, not just the intended flow.

## Code map

- `src/core/store/pipeline.ts` - validation, hash preparation, hash-based dedup, embedding resolution, transaction handling, and persistence.
- `src/core/store/validation.ts` - store-input validation, trimming, defaults, and rejection rules.
- `src/core/store/hashing.ts` - exact and normalized content-hash functions.
- `src/core/store/embedding-text.ts` - canonical text format used for embedding generation.
- `src/core/types.ts` - `StoreEntryInput`, `StoreResult`, and the canonical stored `Entry` type.
- `src/core/store/index.ts` - public store exports used by other core consumers.
- `src/adapters/db/client.ts` - libSQL database adapter, including optional transaction support.
- `src/adapters/db/queries.ts` - insert SQL plus exact-hash and normalized-hash lookup queries.
- `src/adapters/db/schema.ts` - FTS and vector-index lifecycle used by ingest bulk writes.
- `src/core/ingestion/pipeline.ts` - current production wrapper that calls `storeEntriesDetailed()` and maps per-input outcomes back to files.
- `src/app/ingestion/service.ts` - application-layer ingest orchestration that eventually reaches the store pipeline.
- `tests/core/store/*.test.ts` - behavior coverage for validation, hashing, and store-pipeline execution.

## Important architectural nuance

There is no registered `store` CLI command today. `src/cli/main.ts` only registers `ingest` and `db`, and `registerStoreCommand(program)` is still commented out.

That means:

- there is no current `agenr store ...` user-facing command surface to document
- the production write path is ingest calling into the store pipeline
- direct callers are expected to invoke `storeEntries()` or `storeEntriesDetailed()` programmatically

There is also a split between the public and internal store APIs:

- `src/core/store/index.ts` re-exports `storeEntries()`
- `src/core/store/pipeline.ts` also exports `storeEntriesDetailed()`

`storeEntriesDetailed()` is what ingest uses so it can map each accepted, skipped, or rejected input back to a source transcript file. The simpler `storeEntries()` wrapper drops that per-input detail and returns only aggregate counts.

## Input shape

The store pipeline accepts an array of `StoreEntryInput` values:

```ts
interface StoreEntryInput {
  type: EntryType;
  subject: string;
  content: string;
  importance?: number;
  expiry?: "core" | "permanent" | "temporary";
  tags?: string[];
  source_file?: string;
  source_context?: string;
}
```

Notable properties:

- `type`, `subject`, and `content` are required.
- `importance` defaults to `7` after validation.
- `expiry` defaults to `temporary`.
- `tags` default to `[]`.
- `source_file` participates in the exact content hash.
- `source_context` is stored for provenance but does not affect dedup.

## Runtime options

There is no CLI option surface yet, but the pipeline supports these programmatic options:

```ts
interface StoreEntriesOptions {
  dryRun?: boolean;
  verbose?: boolean;
  skipEmbeddings?: boolean;
  precomputedEmbeddings?: number[][];
}
```

- `dryRun` runs validation and dedup planning but skips embedding calls and persistence.
- `verbose` exists in the option type, but the current store pipeline does not use it.
- `skipEmbeddings` stores entries without persisted vectors.
- `precomputedEmbeddings` lets callers reuse vectors computed earlier, aligned to the original input array.

## End-to-end flow

### 1. Validation and normalization

`validateEntriesWithIndexes()` performs the first pass and preserves the original array index for each accepted input.

Current behavior:

- rejects invalid `type` values
- rejects blank `subject`
- rejects blank `content`
- rejects invalid `expiry` values
- rejects `tags` unless the value is a `string[]`
- rejects non-finite `importance`
- trims `subject` and `content`
- rounds and clamps `importance` into `1-10`
- defaults missing `importance` to `7`
- defaults missing `expiry` to `temporary`
- trims tags and drops empty tag strings
- trims `source_file` and `source_context`, dropping them when empty

This validator is intentionally simpler than the extraction parser:

- it does not lowercase or deduplicate tags
- it does not cap tag count
- it does not enforce a minimum content length
- it does not block meta subjects like `user` or `this session`

Invalid inputs become `rejected` outcomes with reason `validation`.

### 2. Hash preparation

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

Important consequence: neither hash includes `type`, `subject`, `tags`, `importance`, or `expiry`. Two entries with different metadata but the same content can still collide in store dedup.

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
- hash computation
- within-batch dedup
- existing-hash database lookups

But dry runs do not perform:

- embedding generation
- entry insertion

`storeEntriesDetailed()` marks pending would-be inserts as `dry_run` details. `storeEntries()` discards those details and returns only aggregate `stored`, `skipped`, and `rejected` counts.

### 5. Embedding resolution

For entries that survive validation and dedup:

- if `skipEmbeddings` is `true`, the pipeline uses `[]` for every pending entry
- otherwise, if `precomputedEmbeddings` is provided, the pipeline reuses those vectors by original input index
- otherwise, it calls the embedding port on the canonical embedding text

Embedding text is currently:

```txt
<type>: <subject> - <content>
```

Precomputed embeddings must match the original input array length exactly. If the array length is wrong or a survivor is missing its aligned vector, the store call throws.

If the embedding provider returns a different number of vectors than pending entries, the store call also throws.

One subtle adapter detail: the core pipeline uses `[]` for skipped-embedding entries, but the libSQL adapter serializes that as `NULL`, so those rows do not participate in vector search until a real embedding exists.

### 6. Persistence

`persistEntries()` writes the surviving prepared entries in order.

Persistence behavior:

- when more than one entry is pending and the database adapter supports `withTransaction()`, the pipeline wraps the writes in one transaction
- otherwise it inserts sequentially without an explicit transaction wrapper
- each stored row gets a fresh UUID
- `created_at` and `updated_at` are both set to the current timestamp
- `quality_score` is initialized to `0.5`
- `recall_count` is initialized to `0`
- `retired` is initialized to `false`
- `content_hash` and `norm_content_hash` are persisted on the row

The SQL adapter stores:

- tags as a JSON array string
- embeddings with `vector32(...)` when a non-empty vector exists
- `NULL` for the embedding column when the vector is empty
- `minhash_sig` as `NULL`

### 7. Ingest wrapper behavior

The core store pipeline itself does not manage FTS or vector-index rebuilds.

That wrapper lives in `storeExtractedResults()` inside `src/core/ingestion/pipeline.ts`. When ingest reaches the store phase and the run is not a dry run, it:

1. flattens all dedup survivors across files
2. calls `db.prepareForBulkWrites()`
3. runs one `storeEntriesDetailed()` call for the whole batch
4. maps per-input outcomes back to per-file store counts
5. writes ingest-log rows per file
6. calls `db.finalizeBulkWrites()`

In the libSQL adapter, that bulk-write cycle:

- drops FTS triggers
- drops the vector index
- recreates FTS triggers
- rebuilds FTS
- recreates the vector index

So the current production path is:

1. ingest extracts entries
2. ingest optionally does semantic dedup
3. store does hash-based dedup and persistence

That means ingest has two separate dedup layers:

- semantic dedup in `src/core/ingestion/dedup.ts`
- hash dedup in `src/core/store/pipeline.ts`
