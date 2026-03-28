# agenr

Agent memory — local-first knowledge infrastructure for AI agents.

Ingest conversation transcripts, extract durable knowledge, store it, recall it, maintain it. Works with any agent system via HTTP API, OpenClaw plugin, or MCP.

## Status

**v0.1.0** — fresh start, building from the ground up.

## Architecture

Pragmatic hexagonal (ports & adapters):

- **`src/core/`** - pure logic, zero infrastructure dependencies. Depends only on port interfaces.
- **`src/app/`** - application orchestration. Composes ports, coordinates workflows, and keeps CLI adapters thin.
- **`src/adapters/`** - infrastructure implementations (database, embeddings, LLM, OpenClaw plugin, MCP, HTTP API).
- **`src/cli/`** - thin CLI commands that wire adapters to core.

The one rule: `core/` never imports from `adapters/` or `cli/`.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm check        # format + lint + typecheck + test
```

## Quickstart

```bash
agenr init        # first-run onboarding, including optional OpenClaw setup
agenr setup       # reconfigure provider, models, keys, and DB path later
```

`agenr setup` writes `~/.agenr/config.json`, supports OpenAI and Anthropic API keys plus Claude Code and Codex CLI subscription auth, and prompts for a separate OpenAI embedding key when the extraction auth does not provide one. `agenr init` can also install the OpenClaw plugin, scan existing sessions, and optionally ingest them on first run.

## License

AGPL-3.0
