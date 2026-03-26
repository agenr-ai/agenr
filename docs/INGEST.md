# Ingest

`agenr ingest <path>` is the production transcript-to-memory pipeline. It is adapter-based in core, but the current CLI is wired specifically to the OpenClaw transcript parser.

This document describes the code as it exists now, not just the intended flow.

## Code map

- `src/cli/commands/ingest.ts` - CLI orchestration, progress reporting, parallel extraction, batch dedup, and batch store.
- `src/core/ingestion/discovery.ts` - target path resolution and transcript file discovery.
- `src/adapters/openclaw/transcript/parser.ts` - OpenClaw JSONL parsing and transcript normalization.
- `src/core/ingestion/extract.ts` - whole-file decision, chunking, retry logic, and extraction prompting.
- `src/core/ingestion/parser.ts` - validation and normalization of extraction-model JSON output.
- `src/core/ingestion/dedup.ts` - within-run semantic dedup using embeddings plus LLM arbitration.
- `src/core/ingestion/pipeline.ts` - single-file extract helper and multi-file store finalization.
- `src/core/store/pipeline.ts` - validation, hash dedup, embedding generation, and persistence.
- `tests/core/ingestion/*.test.ts` and `tests/cli/commands/ingest.test.ts` - behavior coverage for discovery, parsing, extraction, dedup, pipeline, and CLI flags.

## Important architectural nuance

`src/core/ingestion/pipeline.ts` exports `ingestFile()`, but the CLI does not use it for the normal multi-file ingest path.

Instead, the CLI does this:

1. Discover files.
2. Run `extractFile()` in parallel per file.
3. Flatten all extracted entries into one batch.
4. Run one dedup pass across the whole batch.
5. Run one store phase across the whole batch.

That design matters because it enables:

- cross-file dedup inside a single ingest run
- one bulk-write store phase instead of one transaction per file
- reuse of dedup embeddings during the store phase

## Supported inputs

The CLI accepts:

- a single file path
- a directory path

Discovery behavior is slightly different for those two cases:

- If the target is a file, it is accepted as-is. There is no filename filter at discovery time.
- If the target is a directory, discovery walks subdirectories recursively by default and includes files whose names contain `.jsonl` anywhere.

That means these directory-discovered variants are included:

- `session.jsonl`
- `session.jsonl.reset.<timestamp>`
- `session.jsonl.deleted.<timestamp>`

Discovered files are converted to absolute paths and sorted lexicographically before processing.

The parser itself is still OpenClaw-specific, so a random non-OpenClaw file may be discoverable but will not necessarily parse successfully.

## CLI options

```bash
agenr ingest <path> \
  [--verbose] \
  [--dry-run] \
  [--whole-file auto|force|never] \
  [--skip-dedup] \
  [--skip-embeddings] \
  [--concurrency <n>]
```

- `--verbose` emits chunk-level progress, parser warnings, bulk-write lifecycle logs, and per-file usage/cost details.
- `--dry-run` performs discovery, hashing, parsing, extraction, and dedup, but skips persistence and ingest-log writes.
- `--whole-file auto|force|never` controls whether extraction uses one full-session prompt or message-bounded chunks.
- `--skip-dedup` disables the semantic dedup arbitration pass.
- `--skip-embeddings` stores empty vectors instead of persisted embeddings.
- `--concurrency <n>` sets extraction worker count. Default: `10`. Allowed range: `1-16`.

## End-to-end flow

### 1. Config and adapter setup

At startup the CLI:

- loads config via `readConfig()`
- resolves the database path via `resolveDbPath()`
- resolves extraction and dedup models independently
- resolves the embedding model and API key
- opens the database adapter

The extraction model and dedup model can be different. The intended pattern is a stronger extraction model and a cheaper dedup classifier.

## 2. Discovery

`discoverFiles()` resolves the target path, checks whether it is a file or directory, and returns sorted absolute paths.

If no files are found, the command exits cleanly with a warning.

## 3. Per-file extract phase

The CLI runs extraction workers in parallel but preserves input order in the final result list.

For each file, `extractFile()` does the following:

1. Read the raw file and compute a SHA-256 hash.
2. Look up the file path in the ingest log.
3. If the stored hash matches, skip the file without parsing.
4. Parse the transcript through the OpenClaw parser.
5. Run extraction over the normalized transcript.
6. Return extracted entries plus warnings, chunk stats, and the file hash.

A per-file parse or extraction failure does not abort the whole ingest command. It is reported as a failed file and the batch continues.

### Transcript normalization

The OpenClaw parser converts raw JSONL into normalized `TranscriptMessage[]` and metadata:

- system messages are dropped
- pure base64 blobs are dropped
- user and assistant text are whitespace-normalized
- assistant tool calls are summarized into assistant-visible text
- many tool results are dropped and replaced with placeholders rather than raw output
- selected tool results can be kept
- assistant and kept-tool text can be truncated for prompt safety
- timestamps are normalized to ISO-8601 and filled from session metadata, file mtime, or current time when missing

In verbose mode the parser emits a summary warning that includes counts of dropped system messages, dropped tool results, kept tool results, and dropped base64 blocks.

## 4. Extraction

`extractFromTranscript()` is responsible for chunking, prompting, retrying, and parsing the extraction-model response.

### Whole-file vs chunked mode

The `--whole-file` option controls the extraction mode:

- `auto` - use whole-file mode only if the transcript is estimated to fit inside the model context window
- `force` - require whole-file mode and throw if the transcript does not fit
- `never` - always chunk

The auto-fit calculation is conservative. It subtracts:

- the model's max output tokens
- a fixed 4500-token reserve for the system prompt and safety margin

from the model context window before deciding whether the full transcript can fit.

### Chunking behavior

When chunking is required:

- chunks are split on message boundaries only
- the soft ceiling is `8000` estimated tokens per chunk
- token estimation uses a simple `chars / 4` heuristic
- message lines are rendered as `[m00012][user] text`

Each chunk is extracted independently, and later chunks receive a "previously extracted from this file" block so the model can avoid repeating the same knowledge.

### Retry behavior

Each chunk gets up to 3 extraction attempts:

- attempt 1
- retry after 200 ms
- retry after 400 ms

There is also a default 150 ms delay between successful chunk requests.

If all attempts fail for a chunk, ingest records a warning and continues with the remaining chunks.

### Extraction response validation

`parseExtractionResponse()` normalizes the model JSON into `StoreEntryInput[]` and drops invalid entries with warnings.

Current validation behavior includes:

- accepts type aliases like `facts`, `tasks`, and uppercase variants
- maps importance tiers `high|standard|low` to `8|6|4`
- accepts numeric importance `1-10`
- maps `perm` and `temp` expiry aliases
- downgrades extracted `core` expiry to `temporary`
- blocks meta subjects like `user`, `assistant`, `team`, `we`, and `this session`
- requires non-empty content with at least 20 characters
- lowercases and deduplicates tags, capped at 4

## 5. Batch semantic dedup

After all successful files finish extraction, the CLI flattens their entries into one list and runs `dedupBatch()` once.

This dedup pass is within-run only. It compares entries extracted in the current ingest invocation before they reach the store pipeline.

### How dedup works

1. Compose embedding text for every extracted entry.
2. Compute embeddings for the full batch.
3. Cluster entries by cosine similarity using single-linkage union-find.
4. Send only multi-entry clusters to the dedup LLM.
5. Keep, drop, or merge entries based on the LLM decision.

Current runtime details:

- default similarity threshold: `0.75`
- singleton clusters pass through without an LLM call
- LLM arbitration may keep multiple entries in one cluster if they encode different knowledge
- LLM arbitration may merge content into a kept survivor
- if arbitration fails or the response is malformed, the entire cluster is kept

### `--skip-dedup`

When `--skip-dedup` is set, semantic arbitration is bypassed and every extracted entry passes through.

Embedding behavior still depends on the store settings:

- if embeddings will be stored, the dedup stage still computes them so the store phase can reuse them
- if both `--skip-dedup` and `--skip-embeddings` are set, no real embeddings are needed and the CLI uses a no-op embedding port

## 6. Store phase

`storeExtractedResults()` receives the dedup survivors grouped back into their source files, then flattens them again for one store pass.

When there are entries to persist and the run is not a dry run, the database adapter performs a bulk-write cycle:

1. drop FTS triggers and the vector index
2. insert the batch
3. rebuild FTS and recreate the vector index

### Store pipeline behavior

`storeEntriesDetailed()` then performs:

1. validation and normalization
2. within-batch exact-hash dedup
3. exact-hash dedup against the existing database
4. within-batch normalized-content-hash dedup
5. normalized-content-hash dedup against the existing database
6. embedding generation or reuse
7. persistence

This means the ingest path has two separate dedup layers:

- semantic dedup in `src/core/ingestion/dedup.ts`
- hash-based dedup in `src/core/store/pipeline.ts`

The store layer is what protects against cross-run duplicates that were already persisted in earlier ingests.

### Embedding reuse

If semantic dedup ran, the store phase reuses the survivor embeddings produced during dedup instead of embedding the survivors again.

If `--skip-embeddings` is set, stored entries get empty vectors.

### Source-file nuance

The lower-level store pipeline can include `source_file` in the exact content hash when callers provide it.

The current ingest CLI does not stamp `source_file` onto extracted entries before storage, so ingest-produced entries are effectively deduped by content and normalized content rather than file-aware exact hashes. The file path is still preserved in the ingest log.

## 7. Ingest log semantics

The ingest log is used only for file-level change detection.

Current behavior:

- hash comparison happens before parsing
- a file is skipped only when the ingest log has the same file path and same SHA-256 hash
- a successfully extracted file gets an ingest-log row even if zero entries are eventually stored
- failed files do not update the ingest log
- dry runs do not update the ingest log

The logged `entryCount` is the number of entries stored for that file after the store phase, not the number originally extracted.

## 8. Reporting

The CLI reports:

- per-file skipped / failed / success lines
- per-file warnings
- chunk success and failure counts
- dedup summary
- total stored, deduped, rejected, skipped-file, failed-file, and warning counts
- total tokens, total cost, and total LLM calls

In verbose mode it also prints:

- chunk-by-chunk extraction outcomes
- per-file duration
- per-file LLM cost and call count
- bulk-write lifecycle steps
- verbose dedup cluster details

## Config relevant to ingest

A minimal ingest-relevant config looks like this:

```json
{
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "apiKey": "<provider api key>",
  "embeddingApiKey": "<embedding api key or omit to reuse apiKey>",
  "embeddingModel": "text-embedding-3-small",
  "extractionContext": "Optional user or project context injected into extraction prompts.",
  "extractionModel": {
    "model": "gpt-5.4-mini"
  },
  "dedupModel": {
    "model": "gpt-5.4-nano"
  },
  "dbPath": "/absolute/path/to/knowledge.db"
}
```

Notes:

- `extractionModel` and `dedupModel` fall back to the top-level `provider` and `model`
- `AGENR_DB_PATH` overrides `dbPath`
- `AGENR_CONFIG_PATH` overrides the config file location

## Resetting and sandboxing

Use `agenr db reset --yes` to delete and recreate the configured knowledge database.

For sandbox work:

- `sandbox-agenr ingest ...` targets the sandbox database and config
- `sandbox-agenr db reset --yes` resets the sandbox database

The sandbox wrapper already sets `AGENR_DB_PATH` and `AGENR_CONFIG_PATH`, so the config `dbPath` is optional there.

## Good files to read before changing ingest

- `src/cli/commands/ingest.ts`
- `src/core/ingestion/extract.ts`
- `src/core/ingestion/dedup.ts`
- `src/core/ingestion/pipeline.ts`
- `src/adapters/openclaw/transcript/parser.ts`
- `src/core/store/pipeline.ts`
- `tests/core/ingestion/pipeline.test.ts`
- `tests/core/ingestion/extract.test.ts`
- `tests/core/ingestion/dedup.test.ts`
