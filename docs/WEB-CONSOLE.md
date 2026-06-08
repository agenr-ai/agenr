# Web Console

`agenr web` launches a local-only operator console for a solo operator on the same machine as the agenr database. It is a browser surface for the routine workflows that otherwise require the CLI: inspecting corpus health, running dreaming maintenance, reviewing proposals, browsing memory, and editing or syncing procedure YAML.

The console is an operator tool with write authority, but durable memory content stays lifecycle-based. New facts are stored or superseded, metadata is updated, and durables are retired by closing their valid-time window. The console never edits durable content in place and never hard-deletes.

This document describes the code as it exists today. If this file and the code disagree, the code wins.

## Boundaries

The console is a translator, not a second memory brain. The same rule that governs the OpenClaw and Skeln plugins applies here:

1. Shared durable-memory, recall, episode, dreaming, proposal, and claim-key logic belongs in `core/` or `app/`.
2. App-layer web services orchestrate those shared paths for the console. They live under `src/app/web/`.
3. HTTP routing, request validation, same-origin enforcement, SSE transport, and static asset serving belong in `src/adapters/web/`.
4. The CLI entry point stays thin: parse args, optionally register an instance, resolve the built SPA, and start the server.

The console reuses existing app and runtime paths wherever possible:

- dreaming runtime helpers in `src/app/dreaming/runtime.ts`
- proposal review runtime in the dreaming app layer
- durable store, supersede, metadata update, and close-validity semantics in the shared memory paths
- procedure parse, prepare, and execute sync in `src/app/procedures/sync/`

## Security model

The console is loopback-only in v1 with no login and no permissive CORS.

- The server binds to `127.0.0.1` by default. The CLI rejects a non-numeric or out-of-range `--port`.
- Every request passes through `evaluateOriginGuard` in `src/adapters/web/same-origin.ts` before routing.
  - A `Host` header that does not name a loopback authority is rejected to block DNS rebinding.
  - When a browser supplies an `Origin` header, it must name a loopback host on the server's bound port. Cross-origin, malformed-origin, and mismatched-port requests are rejected.
  - Non-browser callers that omit `Origin` (curl, same-origin SPA navigations) are allowed.
- Rejected requests return `403` with `{ status: "error", error: { code: "forbidden" } }` and the reason is logged.
- Request bodies are capped at 2 MB.

There is no network binding or remote access in v1, no session system, and no public HTTP API contract.

## Instance registry

The console operates on one selected instance at a time, chosen from an agenr-owned local registry.

- The registry is a JSON document stored at `web-instances.json` under the agenr config directory, written with `0600` permissions in a `0700` directory.
- Each record stores references only: a display name, an optional config path, an optional database path override, and an optional procedures directory. Database contents are never copied into the registry.
- A record is validated lazily. Resolution loads the referenced config and resolves the database path, so a stale entry never blocks loading the registry itself. The resolved view reports whether the database file currently exists.
- Registry helpers live in `src/app/web/instance-registry.ts`: `registerInstance`, `selectInstance`, `removeInstance`, `resolveSelectedInstance`, and `resolveInstanceRecord`, plus the pure helpers `slugifyInstanceName`, `ensureUniqueInstanceId`, `normalizeOptionalPath`, and `normalizeRegistryDocument`.

Instance-scoped routes resolve the selection through `requireInstanceScope`, which centralizes `requireSelectedInstance`, optional `requireExistingDatabase`, optional `requireProceduresDir`, and optional embedding client creation. Dream job routes additionally verify jobs belong to the selected instance through `requireDreamJobForInstance`. Each failed precondition throws a structured `409` or `404`.

## Code map

Adapter (`src/adapters/web/`):

- `http-server.ts` - the Node HTTP server: origin guard, JSON body reading, API dispatch, SSE invocation, and static SPA fallback
- `router.ts` - method- and pattern-aware router with `:param` capture for JSON and SSE routes
- `same-origin.ts` - the loopback and same-origin guard
- `sse.ts` - a small server-sent-events connection wrapper with heartbeats
- `static-assets.ts` - serves the built SPA and falls back to `index.html` for client-side routes
- `api-error.ts` - the structured `WebApiError` plus the error-envelope serializer
- `validation/requests.ts` - strict query-string and JSON body validation that rejects unexpected fields
- `routes/` - route groups for instances, dreaming/cockpit, proposals, memory, and procedures, aggregated by `routes/index.ts`

App services (`src/app/web/`):

- `instance-registry.ts` - the local instance registry
- `instance-context.ts` - per-operation `withInstanceDatabase` and lazy embedding resolution for a selected instance
- `health-service.ts` - composes the Ops Cockpit snapshot from dreaming status, history, and profile views
- `dreaming-coordinator.ts` - tracks UI-initiated dreaming runs and streams their progress events
- `proposal-service.ts` - proposal backlog, detail, and review
- `memory-browser-service.ts` - durable list, durable detail/trace, episodes, procedures, and claim-key facets
- `memory-lifecycle-service.ts` - store, supersede, metadata update, and close-validity

Supporting adapters:

- `src/adapters/db/web-durable-queries.ts` and `src/adapters/db/web-read-queries.ts` - read-side admin queries for the browser
- `src/adapters/git/worktree-status.ts` - dirty-worktree detection for the procedure editor

CLI:

- `src/cli/commands/web.ts` - the `agenr web` command

Frontend SPA (`web/`):

- A React + Vite + TypeScript single-page app built to `dist/web` and served by the local server from the same origin.
- Shared JSON API types live in `src/web-api/types.ts` and are imported by the SPA through the `@agenr/web-api` alias.

## CLI surface

```bash
agenr web [--host 127.0.0.1] [--port 4319] [--no-open]
          [--register <name> [--db <path>] [--config <path>] [--procedures <dir>]]
```

- `--host` and `--port` control the loopback bind. `--port 0` selects an ephemeral port.
- `--no-open` suppresses the automatic browser launch.
- `--register <name>` registers and selects a convenience instance on launch. `--db`, `--config`, and `--procedures` supply that instance's references.
- When the built SPA is missing, the server still starts in API-only mode and prints a warning suggesting `pnpm build`.

The command stays in the foreground until interrupted with Ctrl-C, then closes the server gracefully.

## API surface

All routes are served from the same origin under `/api/web/*`. Responses are JSON except the dreaming job stream, which is server-sent events. Errors use `{ status: "error", error: { code, message, details? } }`.

Instances:

```txt
GET    /api/web/instances
POST   /api/web/instances
POST   /api/web/instances/:id/select
DELETE /api/web/instances/:id
GET    /api/web/instance
```

Ops Cockpit and dreaming:

```txt
GET    /api/web/cockpit
GET    /api/web/dream/runs
POST   /api/web/dream/runs
GET    /api/web/dream/runs/:runId/actions
GET    /api/web/dream/runs/:runId/proposals
GET    /api/web/dream/jobs/:jobId
POST   /api/web/dream/jobs/:jobId/cancel
GET    /api/web/dream/jobs/:jobId/stream   (SSE)
```

Proposals:

```txt
GET    /api/web/proposals
GET    /api/web/proposals/:id
POST   /api/web/proposals/:id/review
```

Memory:

```txt
GET    /api/web/durables
POST   /api/web/durables
GET    /api/web/durables/:id
POST   /api/web/durables/:id/supersede
POST   /api/web/durables/:id/metadata
POST   /api/web/durables/:id/retire
GET    /api/web/memory/facets
GET    /api/web/episodes
GET    /api/web/procedures
```

Procedure editor:

```txt
GET    /api/web/procedure-files
GET    /api/web/procedure-files/content
POST   /api/web/procedure-files/validate
PUT    /api/web/procedure-files
GET    /api/web/procedure-sync/preview
```

### Boundary strictness

Request bodies and query strings are validated in `src/adapters/web/validation/requests.ts`:

- store and supersede bodies normalize into the shared `StoreDurableInput` shape; unknown keys are rejected
- metadata updates accept only `importance`, `expiry`, `claimKey`, `validFrom`, `validTo`, and `project`, and require at least one field
- proposal review requires a known decision (`apply` or `reject`) and a non-empty reason
- dreaming start requires a known tier and an optional boolean `apply`
- malformed values produce a `400` with field-level issues

## Live dreaming runs

UI-initiated runs are coordinated in-process by `DreamingRunCoordinator`.

- `POST /api/web/dream/runs` starts a run and returns an initial job snapshot with `202`. Only one active run per instance is allowed; a second start returns `409`.
- The job's progress events are buffered and streamed over `GET /api/web/dream/jobs/:jobId/stream`. The stream replays buffered events on subscribe, then ends once the job reaches a terminal status (`completed`, `failed`, or `aborted`), including the case where the job finished before the client connected.
- `POST /api/web/dream/jobs/:jobId/cancel` requests cancellation of an in-flight run via abort signal.
- Run history and details are reload-safe because they come from persisted run and action data, not from the in-process job window.

## SPA pages

- Ops Cockpit: composite corpus-health score, key metric tiles, claim-key lifecycle and recency distributions, proposal backlog and profile rollups, and recent run history with surfaced failures.
- Dreaming Runs: launch light/standard/deep runs in dry-run or apply mode, watch a live progress feed, and inspect persisted run details, actions, and proposals.
- Proposal Review: filterable backlog, a detail drawer with affected durables and current/proposed claim keys, and apply/reject with a required reason.
- Memory Explorer: durable, episode, and procedure browsing with filters and pagination, a durable trace drawer, and lifecycle actions (store, supersede, update metadata, retire).
- Procedure Editor: a YAML editor with debounced validation, a dirty-worktree banner, and save-and-sync that reports created/updated/unchanged results.
- Instance Settings: register, select, and remove instances, with resolution diagnostics and a loopback-only security reminder.

## Build and serving

- The SPA builds with Vite to `dist/web`. `pnpm build` runs `build:root` first (tsup cleans `dist`), then `build:web`, then `build:plugin`, so the SPA output survives the clean.
- At runtime the CLI resolves the SPA directory relative to the compiled `dist/cli.js`. When present, the server serves it and falls back to `index.html` for client-side routes; otherwise it runs API-only.
- The `web/` workspace is excluded from the root ESLint and Prettier pipelines and is typechecked by its own `tsc --noEmit`.

## Non-goals

- No hosted multi-user server, login, or session system.
- No remote database management or network binding.
- No broad public HTTP API contract.
- No durable hard delete and no in-place durable content edits.
- No automatic git commits for procedure YAML changes.
