# Debugging agenr in VS Code

This memo explains how to step through the agenr CLI in VS Code with breakpoints bound to the TypeScript source while targeting the local sandbox.

## What is configured

The repo includes:

- `.vscode/launch.json`
- `.vscode/tasks.json`

The launch configs run `dist/cli.js` under the Node debugger with sourcemaps enabled. The prelaunch task runs:

```bash
pnpm build:debug
```

That build emits sourcemaps so breakpoints in `src/**/*.ts` bind correctly.

## Sandbox wiring

The VS Code launch configs for sandbox-backed commands set the same environment overrides as the local `sandbox-agenr` wrapper:

```bash
AGENR_DB_PATH=/Users/jmartin/.openclaw-sandbox/agenr-data/knowledge.db
AGENR_CONFIG_PATH=/Users/jmartin/.openclaw-sandbox/agenr-data/config.json
```

This means you can debug the normal CLI entrypoint while still hitting the sandbox database and config.

## How to use it

1. Open `~/Code/agenr` in VS Code.
2. Set breakpoints in TypeScript source files.
3. Open Run and Debug.
4. Choose a launch target.
5. Press `F5`.

The debugger runs the compiled CLI entrypoint:

```text
${workspaceFolder}/dist/cli.js
```

with sourcemaps mapped back to TypeScript.

## Available launch targets

Sandbox-backed shared DB/config commands:

- `agenr: ingest entries (sandbox)`
- `agenr: ingest episodes (sandbox)`
- `agenr: recall (sandbox)`
- `agenr: surgeon run structural (sandbox)`
- `agenr: surgeon status (sandbox)`
- `agenr: surgeon history (sandbox)`
- `agenr: surgeon actions (sandbox)`
- `agenr: db reset (sandbox)`

Scenario-focused commands:

- `agenr: scenarios list`
- `agenr: scenarios run ingest`
- `agenr: scenarios run store`
- `agenr: scenarios run surgeon`
- `agenr: scenarios run single ID`

## Important distinction: sandbox DB vs scenario sandboxes

There are two different debugging modes here.

### 1. Shared sandbox DB/config

Commands like `ingest`, `episodes`, `recall`, `surgeon`, and `db reset` are pointed at the shared sandbox database via `AGENR_DB_PATH` and `AGENR_CONFIG_PATH`.

Use these when you want to debug the normal runtime behavior against the local sandbox environment.

### 2. Scenario-isolated sandboxes

The `agenr scenarios ...` commands create and use their own isolated scenario sandboxes internally.

Use these when you want to debug deterministic scenario harness behavior for:

- ingest
- store
- surgeon

This is expected and correct. The scenario runner is intentionally isolated from the shared sandbox database.

## Prompted inputs

Some launch configs prompt for runtime values:

- transcript path
- episode path
- recall query
- surgeon run ID
- scenario ID

Defaults are set in `launch.json`, but you can override them on launch.

## Good breakpoint entry points

CLI entry:

- `src/cli.ts`
- `src/cli/main.ts`

Ingest durable entries:

- `src/cli/commands/ingest.ts`
- `src/app/ingestion/index.ts`
- `src/core/ingestion/index.ts`
- `src/adapters/openclaw/transcript/parser.ts`
- `src/adapters/db/client.ts`

Episode ingest:

- `src/cli/commands/ingest-episodes.ts`
- `src/app/episode-ingest/index.ts`

Recall:

- `src/cli/commands/recall.ts`
- `src/core/recall/index.ts`
- `src/adapters/db/recall-adapter.ts`

Surgeon:

- `src/cli/commands/surgeon.ts`
- `src/app/surgeon/runtime.ts`
- `src/app/surgeon/progress.ts`

Scenarios:

- `src/cli/commands/scenarios.ts`
- `src/app/scenarios/claim-keys/index.ts`

Config resolution:

- `src/config.ts`

## Store debugging note

There is no standalone public `agenr store ...` CLI command at the moment.

If you want to step through store behavior, use:

- `agenr: scenarios run store`

That is the correct debug path for store behavior in the current repo.

## If breakpoints do not bind

Check these first:

1. Run `pnpm build:debug` manually once.
2. Confirm `dist/` exists.
3. Confirm the launch config uses:
   - `program: ${workspaceFolder}/dist/cli.js`
   - `sourceMaps: true`
   - `outFiles: ["${workspaceFolder}/dist/**/*.js"]`
4. Make sure you opened the repo root, not a parent directory.
5. Restart the debug session after editing launch settings.

## Quick examples

Debug durable ingest against the sandbox:

- choose `agenr: ingest entries (sandbox)`
- provide a transcript root such as `/Users/jmartin/.openclaw/sessions`
- set breakpoints in `src/cli/commands/ingest.ts` and deeper app/core layers

Debug recall against the sandbox:

- choose `agenr: recall (sandbox)`
- enter a recall query
- set breakpoints in `src/cli/commands/recall.ts` and `src/core/recall/index.ts`

Debug store path via deterministic scenarios:

- choose `agenr: scenarios run store`
- set breakpoints in scenario runtime and store pipeline code

## Related files

- `AGENTS.md`
- `docs/INGEST.md`
- `docs/EPISODES.md`
- `docs/STORE.md`
- `docs/RECALL.md`
- `docs/SURGEON.md`
- `.vscode/launch.json`
- `.vscode/tasks.json`
