# agenr

**AGENt memoRy** -- local-first memory extraction for AI transcripts.

## Install

```bash
pnpm install
pnpm build
```

Run from source during development:

```bash
node dist/cli.js
```

## First-Time Setup

`agenr` is config-first. Provider/auth/model defaults are stored in `~/.agenr/config.json`.

```bash
agenr setup
```

Setup writes:

- `auth` (one of: `anthropic-oauth`, `anthropic-token`, `anthropic-api-key`, `openai-subscription`, `openai-api-key`)
- `provider` (`anthropic`, `openai`, or `openai-codex`)
- `model`
- optional stored secrets in `credentials`

Environment variables are **secrets only** and do not choose provider/model:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_OAUTH_TOKEN`
- `OPENAI_API_KEY`

## Commands

### `agenr extract <files...>`

Extract structured knowledge from transcript files.

```bash
agenr extract session.jsonl
agenr extract session.jsonl --provider anthropic --model claude-opus-4-6
```

Flags `--provider` and `--model` override config for that run.

### `agenr config set <key> <value>`

Quickly update config values:

```bash
agenr config set auth anthropic-oauth
agenr config set provider anthropic
agenr config set model claude-sonnet-4-20250514
```

### `agenr config set-key <provider> <key>`

Store/update secrets in config:

```bash
agenr config set-key anthropic sk-ant-api03-...
agenr config set-key anthropic-token eyJ...
agenr config set-key openai sk-proj-...
```

### `agenr config show`

Shows auth/provider/model and credential availability. Stored secrets are masked.

### `agenr auth status`

Runs a live auth check (real API call) for the configured model.

## Default CLI Behavior

Running `agenr` without a subcommand prints fast status then help:

- `Status: Authenticated (<provider> / <model>)`
- `Status: Not authenticated (<provider> / <model>) -- run agenr auth status`
- `Status: Not configured -- run agenr setup`

## Output Options

```text
agenr extract <files...>

Options:
  --format <json|markdown>   Output format (default: markdown)
  --output <path>            Output file (or output directory with --split)
  --split                    Write one output artifact per input transcript
  --provider <name>          anthropic | openai | openai-codex
  --model <model>            Provider model ID
  --verbose                  Show extraction progress and debug output
```

## Testing

```bash
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT
