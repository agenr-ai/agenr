# agenr CLI Reference

Source of truth for this document:
- `src/cli.ts`

All syntax below is validated against `pnpm exec agenr <command> -h`.

## Conventions

Use the local CLI from this repo checkout:

```bash
A="pnpm exec agenr"
```

Then run commands as `$A <command>`.

## `setup`

### Syntax

```bash
agenr setup
```

### Options
- None.

### Example

```bash
$A setup
```

### Example Output

```text
How would you like to authenticate?
Select default model:
Configuration saved
```

## `extract`

### Syntax

```bash
agenr extract [options] <files...>
```

### Options
- `--json`: output JSON entries/report format.
- `--format <type>`: `json|markdown` (default `markdown`).
- `--output <file>`: write output file (or directory with `--split`).
- `--split`: one output file per input transcript.
- `--model <model>`: override model.
- `--provider <name>`: `anthropic|openai|openai-codex`.
- `--verbose`: detailed extraction progress.

### Example

```bash
$A extract demo.txt --json --output demo.knowledge.json
```

### Example Output

```text
Extraction Complete
Files: 1
Chunks: 1/1 successful
Entries: 3 entries (0 duplicates removed)
Wrote /absolute/path/demo.knowledge.json
```

## `store`

### Syntax

```bash
agenr store [options] [files...]
```

### Options
- `--db <path>`: database path override.
- `--dry-run`: show write decisions without persisting.
- `--verbose`: show per-entry dedup decisions.
- `--force`: bypass dedup checks and insert all as new.
- `--online-dedup`: enable online LLM dedup at write time (default `true`).
- `--no-online-dedup`: disable online LLM dedup.
- `--dedup-threshold <n>`: similarity threshold for online dedup (`0.0..1.0`, default `0.8`).

### Example

```bash
$A store demo.knowledge.json
```

### Example Output

```text
Store Complete
New: 3 entries added
Updated: 0 entries updated
Skipped: 0 duplicates
Relations: 0 created
Database: 3 total entries
```

## `recall`

### Syntax

```bash
agenr recall [options] [query]
```

### Options
- `--limit <n>`: max results (default `10`).
- `--type <types>`: comma-separated type filter.
- `--tags <tags>`: comma-separated tags filter.
- `--min-confidence <level>`: `low|medium|high`.
- `--since <duration>`: recency filter (`1h`, `7d`, `30d`, `1y`, or ISO timestamp).
- `--expiry <level>`: `core|permanent|temporary|session-only`.
- `--json`: emit JSON.
- `--db <path>`: database path override.
- `--budget <tokens>`: approximate token budget cap.
- `--context <mode>`: `default|session-start|topic:<query>`.
- `--scope <level>`: `private|personal|public`.
- `--no-boost`: use raw vector similarity only.
- `--no-update`: do not increment recall metadata.

### Example

```bash
$A recall "which package manager did we choose?" --limit 3
```

### Example Output

```text
1 results (46ms)
1. [decision] project tooling: We switched this project to pnpm.
   confidence=high | today | recalled 1 time
   tags: tooling, package-manager
```

## `watch`

### Syntax

```bash
agenr watch [options] <file>
```

### Options
- `--interval <seconds>`: polling interval (default `300`).
- `--min-chunk <chars>`: min appended chars before extract (default `2000`).
- `--db <path>`: database path override.
- `--model <model>`: override model.
- `--provider <name>`: `anthropic|openai|openai-codex`.
- `--verbose`: verbose progress.
- `--dry-run`: extract only, do not store.
- `--once`: run one cycle and exit.
- `--json`: output per-cycle JSON.

Watch mode always runs online dedup during store.

### Example

```bash
$A watch ./session.txt --interval 60 --min-chunk 500 --once
```

### Example Output

```text
[18:00:00] Cycle 1: +87 bytes | 1 entries extracted | 1 stored, 0 deduped
Summary: 1 cycles | 1 entries stored | watched for 0s
```

## `ingest`

### Syntax

```bash
agenr ingest [options] <paths...>
```

### Options
- `--glob <pattern>`: file filter glob (default `**/*.{jsonl,md,txt}`).
- `--db <path>`: database path override.
- `--model <model>`: override model.
- `--provider <name>`: `anthropic|openai|openai-codex`.
- `--online-dedup`: enable online LLM dedup at write time (default `false`).
- `--no-online-dedup`: disable online LLM dedup.
- `--dedup-threshold <n>`: similarity threshold for online dedup (`0.0..1.0`, default `0.8`).
- `--verbose`: per-file details.
- `--dry-run`: extract without storing.
- `--json`: emit JSON summary.
- `--concurrency <n>`: parallel extraction workers (default `1`).
- `--skip-ingested`: skip already-ingested file/hash pairs (default `true`).
- `--force`: re-process even if ingested.

### Example

```bash
$A ingest ./notes ./transcripts --glob "**/*.md" --concurrency 2
```

### Example Output

```text
Ingest Complete
Done: 3 files | 3 processed, 0 skipped, 0 failed
Entries: 6 extracted, 3 stored, 3 deduped
Duration: 0s
```

## `consolidate`

### Syntax

```bash
agenr consolidate [options]
```

### Options
- `--rules-only`: run only Tier 1 rule cleanup.
- `--dry-run`: report actions without writing.
- `--min-cluster <n>`: min cluster size for LLM phases (default `2`).
- `--sim-threshold <n>`: Phase 1 clustering threshold (default `0.82`). Phase 2 uses `max(value, 0.88)`.
- `--max-cluster-size <n>`: max cluster size for LLM phases. Defaults: Phase 1 `8`, Phase 2 `6`.
- `--type <type>`: restrict consolidation to one entry type.
- `--show-flagged`: print flagged merges from review queue.
- `--idempotency-days <n>`: skip recently consolidated merged entries (default `7`).
- `--batch <n>`: process `n` clusters this run, then stop and save checkpoint.
- `--no-resume`: ignore existing checkpoint and start fresh.
- `--verbose`: detailed decisions.
- `--json`: output JSON report.
- `--db <path>`: database path override.

### Example

```bash
$A consolidate --dry-run --verbose
```

### Example Output

```text
+--  AGENR -- Knowledge Consolidation (dry run -- no changes made)
|  Phase 1: Rule-Based Cleanup
|  +- Expired entries pruned: 12
|  +- Near-exact duplicates merged: 7
|  +- Orphaned relations cleaned: 3
+--  Done
```

## `mcp`

### Syntax

```bash
agenr mcp [options]
```

### Options
- `--db <path>`: database path override.
- `--verbose`: log requests/responses to stderr.

### Example

```bash
$A mcp --db ~/.agenr/knowledge.db
```

### Example Output

```text
[mcp] agenr MCP server started (protocol 2024-11-05, version 0.1.0)
```

## `auth status`

### Syntax

```bash
agenr auth status
```

### Options
- None.

### Example

```bash
$A auth status
```

### Example Output

```text
Auth Status
Provider: openai
Auth: openai-api-key
Model: gpt-5.2-codex
Ready to extract
```

## `config show`

### Syntax

```bash
agenr config show
```

### Options
- None.

### Example

```bash
$A config show
```

### Example Output

```text
Configuration
Auth: OpenAI API key
Provider: openai
Model: gpt-5.2-codex
Credentials
  OpenAI API Key: ****abcd
Source: env:OPENAI_API_KEY
Available: yes
```

## `config set`

### Syntax

```bash
agenr config set <key> <value>
```

### Arguments
- `key`: `provider|model|auth`
- `value`: new value

### Options
- None.

### Example

```bash
$A config set auth openai-api-key
$A config set model gpt-5.2-codex
```

### Example Output

```text
Updated auth: openai-api-key
Updated model: gpt-5.2-codex
```

## `config set-key`

### Syntax

```bash
agenr config set-key <provider> <key>
```

### Arguments
- `provider`: `anthropic|anthropic-token|openai`
- `key`: secret token/api key

### Options
- None.

### Example

```bash
$A config set-key openai "$OPENAI_API_KEY"
```

### Example Output

```text
Updated openai: stored
Verify with agenr auth status
```

## `db stats`

### Syntax

```bash
agenr db stats [options]
```

### Options
- `--db <path>`: database path override.

### Example

```bash
$A db stats
```

### Example Output

```text
DB Stats
Database: /Users/you/.agenr/knowledge.db
Entries: 42
By Type
- decision: 10
- fact: 9
Top Tags
- tooling: 6
```

## `db export`

### Syntax

```bash
agenr db export [options]
```

### Options
- `--json`: export JSON.
- `--md`: export markdown.
- `--db <path>`: database path override.

Exactly one of `--json` or `--md` is required.

### Examples

```bash
$A db export --json > export.json
$A db export --md > export.md
```

### Example Output (`--md`)

```text
# Agenr Knowledge Export
## fact (12)
- **Build system**: Use pnpm for dependency management.
```

## `db reset`

### Syntax

```bash
agenr db reset [options]
```

### Options
- `--confirm`: required to execute reset.
- `--db <path>`: database path override.

### Example

```bash
$A db reset --confirm
```

### Example Output

```text
Database reset and migrations reapplied.
```

## `db path`

### Syntax

```bash
agenr db path [options]
```

### Options
- `--db <path>`: database path override.

### Example

```bash
$A db path
```

### Example Output

```text
/Users/you/.agenr/knowledge.db
```

---

## Flag Deep Dives

### `--scope` behavior

The `--scope` flag on `recall` controls which entries are visible based on their scope level:

- `--scope private` (default): returns entries with scope `private`, `personal`, or `public`
- `--scope personal`: returns entries with scope `personal` or `public`
- `--scope public`: returns only `public` entries

Scope is assigned when entries are stored. The default scope for CLI-stored entries is `private`. The MCP `agenr_store` tool defaults to `personal`. You can set scope explicitly via the MCP store tool's `scope` parameter.

### `--context` modes

The `--context` flag changes how recall behaves:

- **`default`** (or omitted): Standard semantic search. Requires a query string. Returns entries ranked by the full scoring model (vector similarity × recency × confidence × recall strength).

- **`session-start`**: Designed for AI agents to load at the beginning of a session. No query required. Fetches recent entries (up to 500) without vector search and groups them into categories:
  - **Core**: entries with `expiry=core` (always included, fetched separately)
  - **Active**: open todos (non-session-only)
  - **Preferences**: preferences and decisions
  - **Recent**: everything else, sorted by recency
  
  When used with `--budget`, allocates tokens across categories (30% active, 30% preferences, remainder to recent) with overflow redistribution.

- **`topic:<query>`**: Prepends `[topic: <query>]` to the search text before embedding, biasing results toward that topic. Useful for scoping recall to a specific area (e.g., `--context topic:authentication`).

### `--budget` behavior

The `--budget <tokens>` flag caps the total approximate token count of returned entries. Token estimation counts words in the entry's type, subject, content, confidence, expiry, and tags, then multiplies by 1.3.

In **default** mode: entries are ranked by score, then consumed in order until the budget is exhausted.

In **session-start** mode: the budget is split across categories (30% active, 30% preferences, remaining to recent). Each category consumes entries in score order until its quota is full. Leftover budget is redistributed to remaining entries across all categories.

This is useful for keeping context windows manageable — e.g., `agenr recall --context session-start --budget 2000` loads ≈2000 tokens of the most relevant memories.


## Interrupted Processes and Data Safety

### What's safe

agenr uses SQLite transactions for all write operations. If a process is interrupted (ctrl+C, SIGTERM, OOM kill), uncommitted entries are rolled back cleanly by SQLite's WAL journal. No partial entries will be written.

The `ingest_log` table is only updated after a file is fully processed and stored. If ingestion is killed mid-file, that file won't appear in the log, so `--skip-ingested` will correctly re-process it on the next run. Already-stored entries are deduplicated by content hash.

### What's not safe

The DiskANN vector index (used for semantic search) can become corrupted if a process is killed with SIGKILL during a write. This is a known limitation of libsql's vector index implementation.

Symptoms of a corrupted index:
- `agenr recall` returns no results or hangs
- `agenr db check` reports index issues

### Recovery

```bash
# Check database health
agenr db check

# Rebuild the vector index (drops and recreates)
agenr db rebuild-index
```

Index rebuilds take 10-30 seconds depending on database size. All data is preserved - only the search index is rebuilt.

### Best practices

- Avoid killing agenr with `kill -9` (SIGKILL) during ingestion or consolidation
- If you must force-kill, run `agenr db check` afterward
- Use `ctrl+C` (SIGINT) when possible - agenr will attempt a clean shutdown
- Long-running ingestion: consider running in a terminal directly rather than via tool timeouts
