# agenr Architecture

This document describes how agenr converts raw conversation text into durable, queryable memory using local SQLite/libsql storage, vector search, and memory-aware recall scoring.

## System Overview

```text
              +---------------------------+
              |        CLI / MCP API      |
              | extract/store/recall/...  |
              +-------------+-------------+
                            |
                            v
+-------------------+   +---+-------------------+   +-------------------------+
| Input Parsers     |-> | LLM Extraction Layer  |-> | KnowledgeEntry[]         |
| jsonl/md/txt      |   | extractKnowledge...   |   | typed structured entries |
+-------------------+   +-----------+-----------+   +------------+------------+
                                    |                            |
                                    v                            v
                          +---------+---------+         +--------+----------------+
                          | Embeddings Client |         | Store Pipeline          |
                          | OpenAI 1024d      |         | dedup + relations + log |
                          +---------+---------+         +-----------+-------------+
                                    |                               |
                                    +---------------+---------------+
                                                    v
                                     +--------------+-------------------+
                                     | SQLite/libsql (local file DB)    |
                                     | entries/tags/relations/FTS/vector |
                                     +--------------+-------------------+
                                                    |
                                                    v
                                     +--------------+-------------------+
                                     | Recall Pipeline                  |
                                     | vector candidate -> score -> rank|
                                     +--------------+-------------------+
                                                    |
                                                    v
                                     +--------------+-------------------+
                                     | Consolidation                    |
                                     | rules cleanup + LLM merge tiers  |
                                     +----------------------------------+
```

## Data Flow

1. Text ingestion
- Sources: transcript and text files (`.jsonl`, `.md`, `.txt`) via `src/parser.ts` and command handlers in `src/commands`.

2. LLM extraction
- `extractKnowledgeFromChunks` (`src/extractor.ts`) transforms chunked text into `KnowledgeEntry[]`.

3. Structured entry normalization
- Types/enums are defined in `src/types.ts`.

4. Embedding generation
- `embed()` in `src/embeddings/client.ts` calls OpenAI embeddings API with `text-embedding-3-small` and `dimensions=1024`.

5. Storage and dedup
- `storeEntries()` in `src/db/store.ts` performs similarity search, dedup decisions, relation creation, and writes to DB.

6. Recall
- `recall()` in `src/db/recall.ts` fetches vector candidates, applies filters, computes final score, ranks, and optionally updates recall metadata.

7. Consolidation
- Tier 1 rules (`src/consolidate/rules.ts`) + Tier 2 clustering/merge (`src/consolidate/cluster.ts`, `src/consolidate/merge.ts`, `src/consolidate/verify.ts`).

## Storage Layer

agenr uses libsql/SQLite via `@libsql/client` (`src/db/client.ts`).

Default DB path:
- `~/.agenr/knowledge.db` (resolved in `src/db/client.ts`)

Schema source:
- `src/db/schema.ts`


### `entries` table columns

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | UUID |
| `type` | TEXT | Knowledge type: fact, decision, preference, todo, relationship, event, lesson |
| `subject` | TEXT | Short subject line |
| `canonical_key` | TEXT | Optional canonical key for stable identity |
| `content` | TEXT | Full entry content |
| `importance` | INTEGER | 1-10 (higher means more important to remember) |
| `expiry` | TEXT | core, permanent, temporary |
| `scope` | TEXT | private (default), personal, or public |
| `source_file` | TEXT | Originating file path |
| `source_context` | TEXT | Extraction context |
| `embedding` | F32_BLOB(1024) | 1024-dimensional float32 vector |
| `content_hash` | TEXT | Content hash for idempotency (v2) |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO timestamp |
| `last_recalled_at` | TEXT | ISO timestamp of last recall |
| `recall_count` | INTEGER | Times this entry has been recalled |
| `confirmations` | INTEGER | Reinforcement count from dedup |
| `contradictions` | INTEGER | Contradiction count |
| `superseded_by` | TEXT FK | ID of superseding entry (soft delete) |
| `merged_from` | INTEGER | Number of source entries merged (v3) |
| `consolidated_at` | TEXT | ISO timestamp of last consolidation (v3) |

Primary tables:
- `entries`: core memory records, including metadata and `embedding F32_BLOB(1024)`.
- `tags`: normalized tag mapping (`entry_id`, `tag`).
- `relations`: inter-entry links (`supersedes`, `contradicts`, `elaborates`, `related`).
- `ingest_log`: ingest idempotency and run history.
- `entry_sources`: provenance snapshots for merged entries.
- `entry_sources` columns include `original_confirmations`, `original_recall_count`, and `original_created_at`.

Search/index objects:
- Vector index: `idx_entries_embedding` using `libsql_vector_idx(... metric=cosine (standard similarity metric for text embeddings) ...)`.
- Full text index: `entries_fts` virtual table with insert/update/delete triggers.

Schema policy:
- Pre-release, no migrations. The schema is defined as a single CREATE TABLE block in `src/db/schema.ts`.

## Entry Model

Defined in `src/types.ts`.

Knowledge types (7):
- `fact`
- `decision`
- `preference`
- `todo`
- `relationship`
- `event`
- `lesson`

Importance:
- Integer `1..10` (see `src/schema.ts` and `src/types.ts`)

Expiry levels:
- `core`, `permanent`, `temporary`

Scope levels:
- `private`, `personal`, `public`

Stored entry metadata includes:
- `recall_count`, `last_recalled_at`
- `confirmations`, `contradictions`
- `superseded_by`
- merge lineage fields from migration v3 (`merged_from`, `consolidated_at`)

## Embeddings

Source: `src/embeddings/client.ts`

- Model: `text-embedding-3-small`
- Dimensions: `1024`
- Batch size: `200`
- Max concurrency: `3`
- Input text format: `"<type>: <subject> - <content>"` (`composeEmbeddingText`)

Embedding API key resolution order (`resolveEmbeddingApiKey`):
1. `config.embedding.apiKey`
2. `config.credentials.openaiApiKey`
3. `OPENAI_API_KEY`

## Deduplication Strategy (Store Pipeline)

Source: `src/db/store.ts`

Store uses Mem0-style online dedup:

1. Content-hash fast path
- If `content_hash` already exists, skip before embedding/vector work.

2. Fast vector path
- Find top-k similar active entries (`superseded_by IS NULL`).
- `>= 0.95` + same type: skip as near-exact semantic duplicate.
- `>= 0.88` + same subject + same type: reinforce existing entry (`confirmations += 1`).
- `0.88..0.95` + same subject + different type: insert new entry and create `related` relation.

3. Online LLM decision path
- For remaining candidates above threshold (`dedupThreshold`, default `0.8`), LLM returns one of:
- `ADD`: insert new entry.
- `UPDATE`: update target content, re-embed via `composeEmbeddingText`, bump confirmations.
- `SKIP`: skip insert, bump confirmations on target.
- `SUPERSEDE`: insert new entry, mark target `superseded_by`, create `supersedes` relation.

4. Failure fallback
- If LLM fails or returns invalid tool output, fallback to `ADD` (avoid data loss).

Ingest behavior:
- `ingest` uses the same online dedup path (including LLM decisions) as regular store writes.

Transaction mode:
- Online dedup enabled: per-entry `BEGIN IMMEDIATE`/`COMMIT` so LLM calls stay outside DB lock windows.
- Online dedup disabled: single batch transaction for throughput.

## Recall Scoring Model

Source: `src/db/recall.ts`

Recall starts with vector top-k candidates from `idx_entries_embedding`, then applies filters and scoring.

Core components:
- `vector`: cosine similarity (clamped 0..1, exponentiated by `0.7` in final score path)
- `recency`: FSRS-style forgetting curve (Free Spaced Repetition Scheduler - a spaced repetition algorithm) with expiry-specific half-life:
- `core`: infinite
- `permanent`: 365 days
- `temporary`: 30 days
- `importance`: importance score derived from `importance` (1-10)
- `recall`: strength from `recall_count` and time since last recall
- `fts`: +`0.15` boost if full-text match

Final score (`scoreEntry`) is multiplicative (by design - one bad signal should tank the score, not just reduce it) with contradiction penalty:
- `sim^0.7 * (0.3 + 0.7 * recency) * max(importance, recall_strength) * contradiction_penalty + fts`
- contradiction penalty is `0.8` when `contradictions >= 2`, else `1.0`

## Consolidation Architecture

Consolidation is a two-tier pipeline (`src/commands/consolidate.ts`).

Tier 1 (rules-based):
- Expires low-recency temporary entries.
- Merges near-exact duplicates with structural safeguards.
- Cleans orphaned non-`supersedes` relations.

Tier 2 (LLM-assisted):
- Builds semantic clusters with union-find and diameter-capped validation.
- Generates canonical entries via LLM tool-calling.
- Verifies merged semantics before commit; flags uncertain merges to review queue.

Locking:
- File lock at `~/.agenr/consolidation.lock` to avoid conflicting write flows.

## MCP Server Architecture

Source: `src/mcp/server.ts`

Transport:
- stdio
- JSON-RPC 2.0
- protocol version `2024-11-05`

Exposed tools:
- `agenr_recall`
- `agenr_store`
- `agenr_extract`

Lifecycle:
- lazy DB initialization (`getDb` + migrations)
- strict input validation (tool params, enums, numeric ranges)
- per-call tool dispatch with structured text responses

## Auth and Model Resolution

Auth method definitions and config model:
- `src/config.ts`
- `src/types.ts`

Supported auth methods (5):
- `anthropic-oauth`
- `anthropic-token`
- `anthropic-api-key`
- `openai-subscription`
- `openai-api-key`

Credential resolution:
- `src/llm/credentials.ts`
- Supports env/config credentials plus local CLI credential discovery:
- Codex (`~/.codex/auth.json` or keychain on macOS)
- Claude (`~/.claude/.credentials.json`/`credentials.json` or keychain on macOS)

Provider/model normalization:
- `src/llm/models.ts`
- `src/llm/client.ts`
