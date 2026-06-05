# Ingest

`agenr ingest` has two production paths:

- `agenr ingest <path>` or `agenr ingest durables <path>` for durable entry ingest
- `agenr ingest episodes [path]` for episodic summary backfill and episode embedding backfill

This document describes the code as it exists now.

## Scope

Entry ingest and episode ingest are related, but they are not the same pipeline.

- Entry ingest turns OpenClaw transcripts into durable `entries` rows.
- Episode ingest turns OpenClaw sessions into one narrative `episodes` row per session.
- Both reuse the OpenClaw transcript parser.
- They diverge at discovery, eligibility, storage shape, and CLI behavior.

For the memory model and recall behavior after ingest, see [RECALL.md](./RECALL.md) and [EPISODES.md](./EPISODES.md).

## Code map

- `src/cli/commands/ingest.ts` - top-level `agenr ingest` registration and durable entry ingest CLI
- `src/cli/commands/ingest-episodes.ts` - `agenr ingest episodes` CLI
- `src/app/ingestion/service.ts` - multi-file durable entry orchestration
- `src/app/episode-ingest/service/preflight.ts` - Stage 1 episode preflight and candidate classification
- `src/app/episode-ingest/service/plan.ts` - Stage 2 episode planning and recent-window filtering
- `src/app/episode-ingest/service/execute.ts` - Stage 2 episode generation and upsert execution
- `src/app/episode-ingest/service/backfill.ts` - embedding-only episode backfill
- `src/adapters/files/transcript-files.ts` - generic local file discovery and hashing used by entry ingest
- `src/adapters/openclaw/session/transcript-files.ts` - OpenClaw-specific session discovery used by episode ingest
- `src/adapters/openclaw/session/session-registry.ts` - `sessions.json` metadata lookup for episode ingest
- `src/adapters/openclaw/session/sessions-store-reader.ts` - best-effort `sessions.json` reader with explicit diagnostics for missing, malformed, or unreadable files
- `src/adapters/openclaw/transcript/parser.ts` - OpenClaw JSONL parsing and transcript normalization
- `src/core/ingestion/extract.ts` - chunking, retry logic, and extraction prompting
- `src/core/ingestion/parser.ts` - extraction-response validation and normalization
- `src/core/ingestion/dedup.ts` - within-run semantic dedup
- `src/core/ingestion/claim-key-preservation.ts` - explicit claim-key preservation across dedup
- `src/core/ingestion/source-metadata.ts` - stable source-file, user, and project metadata resolution
- `src/core/ingestion/pipeline.ts` - single-file extract helper plus batch store finalization
- `src/core/store/claim-extraction.ts` - ingest-time claim-key extraction
- `src/core/store/pipeline.ts` - validation, hash dedup, embedding generation, persistence, and auto-supersession

## Durable entry ingest

### CLI

```bash
agenr ingest <path> \
  [--verbose] \
  [--dry-run] \
  [--whole-file auto|force|never] \
  [--skip-dedup] \
  [--concurrency <n>]
```

Current limits:

- default concurrency: `10`
- allowed range: `1-50`

Current flag behavior:

- `--verbose` prints chunk-level details, parser warnings, per-file usage, and bulk-write progress
- `--dry-run` performs discovery, hashing, parsing, extraction, semantic dedup, and claim-key extraction, but skips persistence and ingest-log writes
- `--whole-file auto|force|never` controls whole-transcript extraction versus chunking
- `--skip-dedup` skips LLM arbitration, but the pipeline still computes embeddings so survivors can be stored with vectors
- `--concurrency <n>` caps parallel extraction workers

### Entry ingest architecture

The durable ingest CLI does not call `ingestPath()` directly. It does discovery first, then hands the discovered files to `ingestDiscoveredFiles()` in `src/app/ingestion/service.ts`.

That workflow is:

1. Discover files.
2. Run `extractFile()` in parallel per file.
3. Flatten all extracted entries into one batch.
4. Run one semantic dedup pass across the whole batch.
5. Restore explicit claim-key metadata onto surviving dedup winners when possible.
6. Run best-effort claim-key extraction across the surviving batch when configured.
7. Run one bulk store pass.
8. Update the ingest log for successful extracted files.

That design matters because it enables:

- cross-file semantic dedup inside a single run
- reuse of dedup embeddings during store
- one bulk store phase instead of one transaction per file
- one shared claim-key extraction pass before persistence

The init wizard's optional bulk ingest path reuses the same `ingestDiscoveredFiles()` workflow after it scans likely OpenClaw session files.

### Entry discovery

Entry ingest uses `src/adapters/files/transcript-files.ts`.

Current behavior:

- if the target is a file, it is accepted only when the basename matches a supported transcript shape
- if the target is a directory, discovery is recursive
- recursive directory discovery keeps basenames that match `*.jsonl`, `*.jsonl.reset.*`, or `*.jsonl.deleted.*`
- returned paths are absolute and lexicographically sorted

That means entry ingest will discover:

- `session.jsonl`
- `session.jsonl.reset.<timestamp>`
- `session.jsonl.deleted.<timestamp>`
- `nested/path/custom-export.jsonl`

And it will not discover lookalikes such as:

- `session.jsonl.bak`
- `session.json`

The parser is still OpenClaw-specific, but generic discovery is now strict about transcript basenames so backup and sidecar files do not drift into ingest accidentally.

### Per-file extract phase

Each extraction worker:

1. computes a SHA-256 file hash
2. checks the ingest log by file path
3. skips the file if the stored hash matches
4. parses the transcript with the OpenClaw parser
5. runs extraction
6. returns entries, warnings, chunk stats, and the file hash

Per-file failures do not abort the whole run. The batch continues and the failed file is reported at the end.

### Transcript normalization

The OpenClaw parser normalizes raw JSONL into `ParsedTranscript` plus warnings. The same parser is shared by entry ingest, episode ingest, and continuity-related OpenClaw flows.

Important current behaviors include:

- system messages are dropped
- pure base64 blobs are dropped
- user and assistant text is whitespace-normalized
- leading untrusted metadata blocks are stripped from user messages before extraction
- assistant tool calls are summarized into assistant-visible text
- many tool results are collapsed into placeholders instead of being kept verbatim
- selected tool results can be preserved
- assistant and kept-tool text may be truncated for prompt safety
- timestamps are normalized to ISO-8601
- transcript metadata carries session identity, transcript hash, source identity, working directory, and reconstructed surface hints when available

### Whole-file versus chunked extraction

The `--whole-file` flag controls whether extraction runs on the full transcript or on message-bounded chunks.

- `auto` - use whole-file mode only if the estimated transcript fits inside the usable model window
- `force` - require whole-file mode and throw if the transcript will not fit
- `never` - always chunk

The usable model window is:

- context window
- minus max output tokens
- minus a fixed `4500` token reserve for the system prompt and safety margin

If chunking is needed:

- chunks never split messages
- the soft ceiling is `8000` estimated tokens per chunk
- token estimation uses a simple `chars / 4` heuristic
- prompt lines are rendered as `[m00012][user] text`
- later chunks receive a summary of previously extracted subjects to reduce duplicate output

### Retry behavior

Each chunk gets up to 3 attempts.

- retry 2 happens after `200ms`
- retry 3 happens after `400ms`
- there is also a default `150ms` delay between chunk requests

If a chunk still fails, the file stays in the batch with a warning and ingest continues with the remaining chunks.

### Extraction response validation

`parseExtractionResponse()` validates model output before any dedup or store step.

Current normalization behavior includes:

- accepts plural aliases like `facts`
- maps `event` and `events` to `milestone`
- rejects unsupported type labels
- maps importance tiers `high`, `standard`, and `low` to `8`, `6`, and `4`
- accepts numeric importance `1-10`
- accepts `perm` and `temp` expiry aliases
- downgrades extracted `core` expiry to `temporary`
- blocks meta subjects such as `user`, `assistant`, `team`, `we`, and `this session`
- requires content of at least 20 characters
- lowercases and deduplicates tags, capped at 4
- preserves explicit `claim_key` values when they normalize successfully

### Semantic dedup

After extraction, the workflow flattens all successful files and calls `dedupBatch()` once.

This pass is within-run only. It does not look at already stored database rows.

Current algorithm:

1. compose embedding text for every extracted entry
2. compute embeddings for the full batch
3. cluster entries by cosine similarity using single-linkage union-find
4. send only multi-entry clusters to the dedup LLM
5. keep, drop, or merge entries based on the LLM decision

Current runtime details:

- default similarity threshold: `0.75`
- singleton clusters pass through without an LLM call
- malformed or failed arbitration keeps the whole cluster
- `--skip-dedup` still computes embeddings, but returns a passthrough result with no LLM arbitration

### Claim-key handling during ingest

Claim-key handling is now part of the ingest workflow, not an afterthought.

There are three relevant steps:

1. Explicit `claim_key` values returned by extraction are normalized and preserved on the extracted rows.
2. After semantic dedup, `restoreExplicitClaimKeysAfterDedup()` reattaches explicit claim-key metadata to winning survivors when the cluster agrees on a single explicit key.
3. If claim extraction is enabled, `runBatchClaimExtraction()` runs across the dedup survivors and applies accepted lifecycle metadata directly onto the entries before store.

The durable ingest CLI resolves claim extraction through `resolveClaimExtractionConfig(config)` and can use a dedicated claim model via `resolveModel(config, "claim")`.

By default, claim extraction is:

- enabled
- thresholded at `0.8`
- limited to `fact`, `preference`, `decision`, and `lesson`

The CLI also prints a compact claim-key health summary for the final store candidates.

### Source metadata resolution

Before store, ingest also normalizes source metadata:

- `source_file` is rewritten to a stable transcript identity when the raw path was a rotated `.reset` or `.deleted` snapshot
- `user_id` falls back to transcript metadata when present
- `project` can come from transcript metadata, or be inferred conservatively from the working directory when the extracted row clearly references that project

### Store phase

`storeExtractedResults()` regroups survivors by source file for reporting, then flattens them again for one store pass.

When the run is not a dry run and there are entries to write, the database adapter performs a bulk-write cycle:

1. drop entry FTS triggers
2. drop vector indexes when supported by the SQLite build
3. store the batch
4. recreate triggers
5. rebuild FTS
6. recreate vector indexes

Inside `storeDurablesDetailed()`, the current store pipeline does:

1. validation and normalization
2. within-batch exact content-hash dedup
3. exact content-hash dedup against the existing database
4. within-batch normalized-content-hash dedup
5. normalized-content-hash dedup against the existing database
6. embedding generation or reuse
7. conservative claim-key auto-supersession planning for eligible same-slot entries
8. persistence plus any explicit or auto-supersession links

This means durable ingest has two dedup layers:

- semantic dedup in `src/core/ingestion/dedup.ts`
- hash-based dedup in `src/core/store/pipeline.ts`

The store layer is what protects against duplicates that already existed before the current run.

### Ingest log semantics

The ingest log is only a file-level change detector.

Current behavior:

- hash comparison happens before parsing
- skip requires the same file path and the same SHA-256 hash
- successful extracted files get an ingest-log row even if zero entries were stored for that file
- failed files do not update the ingest log
- dry runs do not update the ingest log

The logged `entryCount` is the post-store stored count for that file, not the raw extracted count.

### Entry ingest reporting

The CLI reports:

- skipped, failed, and successful files
- per-file warnings
- dedup summary
- claim-key health summary when available
- total stored, deduped, rejected, skipped-file, failed-file, and warning counts
- total tokens, cost, and LLM calls

Verbose mode additionally prints:

- chunk-by-chunk extraction outcomes
- per-file duration and usage
- bulk-write lifecycle updates
- verbose dedup cluster details

## Episode ingest

### CLI

```bash
agenr ingest episodes <path> \
  [--db <path>] \
  [--recent <duration>] \
  [--regenerate] \
  [--embed-only] \
  [--no-embed] \
  [--dry-run] \
  [--verbose] \
  [--concurrency <n>] \
  [--model <provider/model|model>]
```

Current limits:

- default concurrency: `10`
- allowed range: `1-50`

Current flag behavior:

- `--db <path>` overrides the configured database path for this run
- `--recent <duration>` keeps only sessions ending within a relative window like `30d` or an ISO timestamp
- `--regenerate` allows already-stored sessions to be regenerated
- `--embed-only` backfills embeddings for stored episodes missing vectors and does not require a transcript path
- `--no-embed` skips embedding newly generated summaries
- `--dry-run` runs preflight and planning only, then stops before summary generation and writes
- `--verbose` prints per-session progress
- `--model <provider/model|model>` overrides the episode summary model

### Episode discovery

Episode ingest does not use the generic entry-ingest discovery adapter.

It uses `src/adapters/openclaw/session/transcript-files.ts`, which matches only OpenClaw session file names:

- `<uuid>.jsonl`
- `<uuid>.jsonl.reset.<timestamp>`
- `<uuid>.jsonl.deleted.<timestamp>`

If the target is a single file and the basename does not match that OpenClaw pattern, episode ingest treats it as no files found.

### Episode pipeline

Episode ingest is split into explicit stages.

#### Stage 1 - Preflight

`prepareEpisodeIngest()` discovers files, parses them, and classifies each transcript as:

- candidate
- skipped
- invalid

Current preflight skip rules:

- `skipped_exists` - an episode already exists for the session or transcript hash and `--regenerate` was not set
- `skipped_short` - fewer than `4` cleaned messages remain after transcript normalization
- `skipped_active` - the session appears active because `endedAt` is within the last `5` minutes

Current invalid rule:

- no usable session id and no cleaned messages

For candidates, preflight renders the transcript text used by the summary model and caps it at `14000` characters.

#### Session metadata reconstruction

Episode preflight resolves session metadata in this order:

1. authoritative `sessions.json` registry metadata when available
2. reconstructed transcript surface metadata from the OpenClaw parser
3. agent id derived from the OpenClaw directory layout when needed

If `sessions.json` is missing, malformed, unreadable, or structurally invalid, episode ingest treats the registry as unavailable and continues with transcript reconstruction instead of aborting preflight.

That gives the current best-effort values for:

- `sessionId`
- `sourceRef`
- `agentId`
- `surface`
- metadata source (`registry`, `reconstructed`, or `none`)

#### Stage 2 - Plan

`createEpisodeIngestPlan()` applies the optional `--recent` cutoff and estimates:

- selected candidate count
- input tokens
- output tokens
- estimated summary cost

If `--recent` is set, undated candidates are excluded.

#### Stage 2 - Execute

`executeEpisodeIngestPlan()` runs summary generation with concurrency-limited workers and serialized writes.

Each candidate:

1. generates a structured summary
2. optionally embeds the summary
3. upserts the episode row

Session results are reported as:

- `written`
- `updated`
- `unchanged`
- `failed`

### Episode-only nuances

- `--embed-only` reads existing episodes from the database and backfills missing embeddings without parsing transcripts
- normal episode ingest shows a relevance warning when the sampled transcript provenance does not look related to the existing database contents
- episode ingest uses the OpenClaw session registry when it can, while durable entry ingest does not

## Config relevant to ingest

A representative ingest-relevant config looks like this:

```json
{
  "auth": "openai-api-key",
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "credentials": {
    "openaiApiKey": "<OpenAI API key>"
  },
  "embeddingModel": "text-embedding-3-small",
  "extractionContext": "Optional user or project context injected into extraction prompts.",
  "extractionModel": {
    "model": "gpt-5.4-mini"
  },
  "dedupModel": {
    "model": "gpt-5.4-nano"
  },
  "episodeModel": {
    "model": "gpt-5.4-mini"
  },
  "claimExtraction": {
    "enabled": true,
    "confidenceThreshold": 0.8,
    "eligibleTypes": ["fact", "preference", "decision", "lesson"]
  },
  "dbPath": "/absolute/path/to/knowledge.db"
}
```

Notes:

- `extractionModel`, `dedupModel`, `episodeModel`, and `claimExtraction.model` all fall back to the top-level `provider` and `model`
- `AGENR_DB_PATH` overrides `dbPath`
- `AGENR_CONFIG_PATH` overrides the config file location
- embeddings still require OpenAI-compatible embedding credentials even if extraction uses another auth path

## Resetting and sandboxing

Use `agenr db reset --yes` to delete and recreate the configured knowledge database.

For sandbox work:

- `sandbox-agenr ingest ...` targets the sandbox database and config
- `sandbox-agenr ingest episodes ...` does the same for episode backfill
- `sandbox-agenr db reset --yes` resets the sandbox database

The sandbox wrappers already set the database and config environment overrides.

## Good files to read before changing ingest

- `src/cli/commands/ingest.ts`
- `src/cli/commands/ingest-episodes.ts`
- `src/app/ingestion/service.ts`
- `src/app/episode-ingest/service/preflight.ts`
- `src/app/episode-ingest/service/plan.ts`
- `src/app/episode-ingest/service/execute.ts`
- `src/core/ingestion/extract.ts`
- `src/core/ingestion/dedup.ts`
- `src/core/ingestion/pipeline.ts`
- `src/core/store/claim-extraction.ts`
- `src/core/store/pipeline.ts`
- `src/adapters/openclaw/transcript/parser.ts`
