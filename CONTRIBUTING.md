# Contributing to agenr

Thanks for contributing to agenr.

## Development Setup

```bash
git clone https://github.com/agenr-ai/agenr.git
cd agenr
pnpm install
pnpm build
pnpm test
```

Requirements:
- Node.js `>=20`
- pnpm

## Project Structure

```text
src/
  cli.ts
  commands/      # CLI command handlers
  db/            # schema, store, recall, relations
  consolidate/   # rules + clustering + merge + verification
  mcp/           # MCP server
  llm/           # model/auth/credential resolution
  embeddings/    # embedding client/cache
  watch/         # watch state + polling loop
  types.ts

tests/           # vitest suite
```

## Testing

agenr uses Vitest.

```bash
pnpm test
```

Before opening a PR:
- run `pnpm test`
- ensure your change includes or updates tests when behavior changes

## Code Style

- TypeScript with strict typing expectations.
- ESM module format (`"type": "module"`).
- Prefer small, focused functions and explicit error messages.
- Keep CLI behavior consistent with `/Users/jmartin/Code/agenr/src/cli.ts` command contracts.

## Pull Request Process

1. Create a focused branch from current mainline.
2. Keep changes scoped to a single concern.
3. Add/update tests for behavior changes.
4. Include clear PR description:
- what changed
- why it changed
- how it was validated
5. Ensure CI/test checks pass before requesting review.

## License

By contributing, you agree your contributions are licensed under AGPL-3.0.

- CLA is not required.
- See `/Users/jmartin/Code/agenr/LICENSE` and `/Users/jmartin/Code/agenr/LICENSE-FAQ.md`.
