# Ingest CLI

`agenr ingest <path>` runs the end-to-end ingestion pipeline for OpenClaw transcript files:

1. Check the ingest log for unchanged files
2. Parse transcripts and extract durable knowledge with the extraction model
3. Batch accepted entries into one serial store phase
4. Record file hashes in the ingest log

## Supported inputs

- A single transcript file
- A directory of transcript files
- OpenClaw transcript variants that contain `.jsonl` anywhere in the filename, including:
  - `.jsonl`
  - `.jsonl.reset.<timestamp>`
  - `.jsonl.deleted.<timestamp>`

Directory ingestion walks subdirectories recursively and processes files in sorted order.

## Options

```bash
agenr ingest <path> [--verbose] [--dry-run] [--whole-file auto|force|never] [--skip-embeddings] [--concurrency 4]
```

- `--verbose` shows per-file warnings, timing, and per-file cost
- `--dry-run` parses and extracts without writing entries or ingest-log records
- `--whole-file <mode>` controls extraction chunking behavior
- `--skip-embeddings` stores entries without computing embeddings
- `--concurrency <n>` limits how many files run through parse and extract in parallel (default: `4`, range: `1-16`)

The ingest summary reports aggregate token usage, LLM call count, and total cost before the final outro line.

## Resetting the database

Use `agenr db reset [--yes]` to delete and recreate the configured knowledge database.

For sandbox work, `sandbox-agenr db reset --yes` resets the isolated sandbox database and immediately recreates the schema.

## Sandbox config

The sandbox config at `~/.openclaw-sandbox/agenr-data/config.json` needs the v1 shape before manual ingest testing. A minimal example:

```json
{
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "apiKey": "<carried over from v0 credentials.openaiApiKey>",
  "embeddingApiKey": "<same key or separate>",
  "extractionModel": {
    "model": "gpt-5.4-mini"
  },
  "dedupModel": {
    "model": "gpt-5.4-nano"
  },
  "dbPath": "/Users/jmartin/.openclaw-sandbox/agenr-data/knowledge.db"
}
```

The `sandbox-agenr` wrapper already sets `AGENR_DB_PATH` and `AGENR_CONFIG_PATH`, so the `dbPath` entry is optional in practice.
