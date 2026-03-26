# Ingest CLI

`agenr ingest <path>` runs the end-to-end ingestion pipeline for OpenClaw transcript files:

1. Parse the transcript
2. Extract durable knowledge with the extraction model
3. Store accepted entries in the database
4. Record the file hash in the ingest log

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
agenr ingest <path> [--verbose] [--dry-run] [--whole-file auto|force|never] [--skip-embeddings]
```

- `--verbose` shows per-file warnings and timing
- `--dry-run` parses and extracts without writing entries or ingest-log records
- `--whole-file <mode>` controls extraction chunking behavior
- `--skip-embeddings` stores entries without computing embeddings

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
