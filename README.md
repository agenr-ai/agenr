# agenr

Agent memory — local-first knowledge infrastructure for AI agents.

Ingest conversation transcripts, extract durable knowledge, store it, recall it, maintain it. Works with any agent system via HTTP API, OpenClaw plugin, or MCP.

## Status

**v0.1.0** — fresh start, building from the ground up.

## Architecture

Pragmatic hexagonal (ports & adapters):

- **`src/core/`** — pure logic, zero infrastructure dependencies. Depends only on port interfaces.
- **`src/adapters/`** — infrastructure implementations (database, embeddings, LLM, OpenClaw plugin, MCP, HTTP API).
- **`src/cli/`** — thin CLI commands that wire adapters to core.

The one rule: `core/` never imports from `adapters/` or `cli/`.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm check        # format + lint + typecheck + test
```

## License

MIT
