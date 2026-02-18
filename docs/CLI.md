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
- `--no-dedup`: skip post-extraction LLM dedup pass.
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
- `--platform <name>`: platform tag (`openclaw|claude-code|claude|codex`).
- `--project <name>`: project tag (lowercase).
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
- `--min-importance <n>`: minimum importance (1-10).
- `--since <duration>`: recency filter (`1h`, `7d`, `30d`, `1y`, or ISO timestamp).
- `--expiry <level>`: `core|permanent|temporary`.
- `--platform <name>`: platform filter (`openclaw|claude-code|claude|codex`).
- `--project <name>`: project filter (comma-separated for multiple).
- `--exclude-project <name>`: exclude entries from project (comma-separated for multiple).
- `--strict`: when used with `--project`, excludes NULL-project entries from results.
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
   importance=7 | today | recalled 1 time
   tags: tooling, package-manager
```

## `eval recall`

Behavioral regression testing for the current recall scoring algorithm. This command is read-only and does not make model calls.

### Syntax

```bash
agenr eval recall [options]
```

### Options
- `--save-baseline`: save current results to `~/.agenr/eval-baseline.json`.
- `--compare`: compare current results against the saved baseline.
- `--queries <path>`: custom query set JSON path (default `~/.agenr/eval-queries.json`).
- `--limit <n>`: results per query (default `10`).
- `--budget <n>`: token budget passed to session-start recall (default `2000`).

### Example

```bash
$A eval recall --limit 5
```

## `context`

Generate a context file for AI tool integration using session-start recall (no embedding API calls).

### Syntax

```bash
agenr context [options]
```

### Options
- `--output <path>`: output file path (default `~/.agenr/CONTEXT.md`).
- `--budget <tokens>`: approximate token budget (default `2000`).
- `--limit <n>`: max entries per category (default `10`).
- `--db <path>`: database path override.
- `--platform <name>`: platform filter (`openclaw|claude-code|claude|codex`).
- `--project <name>`: project filter (comma-separated for multiple).
- `--exclude-project <name>`: exclude entries from project (comma-separated for multiple).
- `--strict`: when used with `--project`, excludes NULL-project entries from results.
- `--json`: output JSON.
- `--quiet`: suppress stderr output.

### Example

```bash
$A context --output ~/.agenr/CONTEXT.md
```

### Example Output

```text
Wrote ~/.agenr/CONTEXT.md
```

## `watch`

### Syntax

```bash
agenr watch [file] [options]
```

### Options
- `--dir <path>`: watch a sessions directory and auto-follow active session file.
- `--platform <name>`: resolver selection (`openclaw|claude-code|claude|codex|mtime`). When used without `--dir`, agenr resolves the platform default directory automatically.
- `--auto`: deprecated. Equivalent to `--platform openclaw` (prints a warning).
- `--interval <seconds>`: polling interval (default `300`).
- `--min-chunk <chars>`: min appended chars before extract (default `2000`).
- `--db <path>`: database path override.
- `--model <model>`: override model.
- `--provider <name>`: `anthropic|openai|openai-codex`.
- `--verbose`: verbose progress.
- `--dry-run`: extract only, do not store.
- `--once`: run one cycle and exit.
- `--json`: output per-cycle JSON.

Pick exactly one mode:
- file mode: `agenr watch <file>`
- directory mode: `agenr watch --dir <path> [--platform ...]`
- platform mode: `agenr watch --platform <name>`

Watch mode runs online dedup during store.

### Example

```bash
$A watch ./session.txt --interval 60 --min-chunk 500 --once
```

```bash
$A watch --dir ~/.openclaw/agents/main/sessions --platform openclaw
```

```bash
$A watch --platform openclaw --interval 120
```

### Example Output

```text
[18:00:00] Cycle 1: +87 bytes | 1 entries extracted | 1 stored, 0 deduped | file=/abs/path/session.jsonl
Summary: 1 cycles | 1 entries stored | watched for 0s
```

## `todo`

Manage todo entries in the knowledge base.

### Syntax

```bash
agenr todo <subcommand> <subject> [options]
```

### Options
- `--db <path>`: database path override.

### Subcommands
- `done <subject>`: fuzzy-match active todos by subject and retire one by setting `superseded_by = id`.

### Example

```bash
$A todo done "fix client test"
```

## `daemon`

### Syntax

```bash
agenr daemon <subcommand> [options]
```

### Subcommands
- `install`: install + start watch daemon via launchd (macOS only).
  - `--force`: overwrite existing plist.
  - `--interval <seconds>`: watch interval (default `120`).
  - `--dir <path>`: sessions directory to watch (overrides auto-detection).
  - `--platform <name>`: platform name (`openclaw|claude-code|claude|codex`). If provided without `--dir`, uses the platform default directory.
  - `--node-path <path>`: node binary path override (useful for nvm/fnm/volta setups without stable symlinks).
- `start`: start the daemon if installed.
- `stop`: stop the daemon without uninstalling (plist remains on disk).
- `restart`: restart the daemon.
- `uninstall`: stop + remove daemon plist.
  - `--yes`: skip uninstall confirmation prompt.
- `status`: show loaded/running status, current watched file, recent logs.
  - `--lines <n>`: log lines to include (default `20`).
- `logs`: print/follow daemon log output.
  - `--lines <n>`: line count (default `100`).
  - `--follow`: follow continuously (`tail -f` behavior).

### Example

```bash
$A daemon install --force
$A daemon start
$A daemon stop
$A daemon restart
$A daemon status
$A daemon logs --lines 50
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
- `--platform <name>`: platform tag (`openclaw|claude-code|claude|codex`).
- `--project <name>`: project tag (lowercase).
- `--verbose`: per-file details.
- `--dry-run`: extract without storing.
- `--json`: emit JSON summary.
- `--concurrency <n>`: parallel chunk extractions (default `5`).
- `--skip-ingested`: skip already-ingested file/hash pairs (default `true`).
- `--no-retry`: disable auto-retry for failed files.
- `--max-retries <n>`: maximum auto-retry attempts (default `3`).
- `--force`: clean re-ingest each matched file by deleting previous rows for that source file first.

Ingest runs online dedup at store time (including LLM classification for ambiguous similarity bands).

### Example

```bash
$A ingest ./notes ./transcripts --glob "**/*.md" --concurrency 2
```

### Example Output

```text
Ingest Complete
Done: 3 files | 3 processed, 0 skipped, 0 failed
Entries: 6 extracted, 3 stored, 2 skipped (duplicate), 1 reinforced
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
- `--platform <name>`: scope consolidation to platform (`openclaw|claude-code|claude|codex`).
- `--project <name>`: scope consolidation to project (comma-separated for multiple).
- `--exclude-project <name>`: exclude entries from project (comma-separated for multiple).
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
[mcp] agenr MCP server started (protocol 2024-11-05, version 0.4.0)
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
- `--platform <name>`: filter stats by platform (`openclaw|claude-code|claude|codex`).
- `--project <name>`: filter stats by project (comma-separated for multiple).
- `--exclude-project <name>`: exclude entries from project (comma-separated for multiple).

### Example

```bash
$A db stats
```

### Example Output

```text
DB Stats
Database: /Users/you/.agenr/knowledge.db
Schema Version: 0.5.0
Entries: 42
By Type
- decision: 10
- fact: 9
By Platform
- openclaw: 20
- claude-code: 12
- codex: 3
- (untagged): 7
By Project
- repo-a: 18
- repo-b: 10
- (untagged): 14
Top Tags
- tooling: 6
```

## `db version`

### Syntax

```bash
agenr db version [options]
```

### Options
- `--db <path>`: database path override.

### Example

```bash
$A db version
```

### Example Output

```text
agenr v0.4.0
Database schema version: 0.4.0
Database created: 2026-02-14 00:00:00
Last migration: 2026-02-17 00:00:00
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
- `--platform <name>`: platform filter (`openclaw|claude-code|claude|codex`).
- `--project <name>`: project filter (comma-separated for multiple).
- `--exclude-project <name>`: exclude entries from project (comma-separated for multiple).

Exactly one of `--json` or `--md` is required.

### Examples

```bash
$A db export --json > export.json
$A db export --md > export.md
$A db export --json --platform openclaw > export.openclaw.json
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

- **`default`** (or omitted): Standard semantic search. Requires a query string. Returns entries ranked by the full scoring model (vector similarity × recency × memory strength, with contradiction penalties and optional full-text boost).

  - **`session-start`**: Designed for AI agents to load at the beginning of a session. No query required. Fetches recent entries (up to 500) without vector search and groups them into categories:
  - **Core**: entries with `expiry=core` (always included, fetched separately)
  - **Active**: todos
  - **Preferences**: preferences and decisions
  - **Recent**: everything else, sorted by recency
  
  When used with `--budget`, allocates tokens across categories dynamically via `computeBudgetSplit()` based on category counts: active receives ~10-30%, preferences ~20-40%, and the remainder goes to recent (with a minimum 20% floor for recent), with overflow redistribution.

- **`topic:<query>`**: Prepends `[topic: <query>]` to the search text before embedding, biasing results toward that topic. Useful for scoping recall to a specific area (e.g., `--context topic:authentication`).

### `--budget` behavior

The `--budget <tokens>` flag caps the total approximate token count of returned entries. Token estimation counts words in the entry's type, subject, content, importance, expiry, and tags, then multiplies by 1.3.

In **default** mode: entries are ranked by score, then consumed in order until the budget is exhausted.

In **session-start** mode: the budget is split across categories dynamically via `computeBudgetSplit()` based on category counts (active ~10-30%, preferences ~20-40%, remainder to recent with a 20% minimum floor for recent). Each category consumes entries in score order until its quota is full. Leftover budget is redistributed to remaining entries across all categories.

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
