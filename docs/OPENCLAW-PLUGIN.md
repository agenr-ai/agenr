# OpenClaw Plugin

`src/adapters/openclaw/` is the production agenr integration for OpenClaw.
The publishable plugin package lives at `packages/openclaw-plugin` and ships as `@agenr/openclaw-plugin`.
The OpenClaw manifest id remains `agenr`, so runtime identity and config keys stay stable even though the npm package name is different.

Today it plays four roles at once:

- OpenClaw memory plugin entrypoint
- OpenClaw tool adapter for five agenr tools
- session continuity adapter around OpenClaw lifecycle hooks
- OpenClaw transcript parser reused by ingest and summary generation

This document describes the code as it exists now, not just the intended flow.

## Code map

- `src/adapters/openclaw/index.ts` - plugin entry, OpenClaw event registration, tool registration, memory-slot wiring, and shutdown cleanup.
- `src/adapters/openclaw/openclaw.plugin.json` and `src/adapters/openclaw/config.ts` - manifest-defined config schema plus runtime config normalization.
- `packages/openclaw-plugin/package.json`, `packages/openclaw-plugin/openclaw.plugin.json`, and `packages/openclaw-plugin/src/index.ts` - plugin-only package metadata and publishable entrypoint.
- `src/adapters/openclaw/runtime.ts` - shared agenr service construction: config loading, DB setup, embedding availability resolution, and recall adapter wiring.
- `src/adapters/openclaw/tools.ts` - `agenr_store`, `agenr_recall`, `agenr_update`, `agenr_retire`, and `agenr_trace`.
- `src/adapters/openclaw/format/prompt-section.ts` - static system-prompt guidance about when to use agenr tools.
- `src/adapters/openclaw/format/recall-format.ts` - session-start prompt rendering for recalled core memory.
- `src/adapters/openclaw/hooks/before-prompt-build.ts` - session-start recall plus predecessor continuity injection.
- `src/adapters/openclaw/hooks/before-reset.ts` - outgoing-session summary generation trigger.
- `src/adapters/openclaw/session/state.ts` - in-process continuity tracker for first-run suppression and predecessor lookup.
- `src/adapters/openclaw/session/predecessor.ts` - tracked predecessor resolution plus TUI `sessions.json` fallback.
- `src/adapters/openclaw/session/summary.ts` and `src/adapters/openclaw/session/summary-reader.ts` - sidecar summary generation, reuse, and file lookup.
- `src/adapters/openclaw/session/tui-lane.ts` and `src/adapters/openclaw/session/sessions-store-reader.ts` - TUI lane parsing and `sessions.json` normalization.
- `src/adapters/openclaw/memory/runtime.ts` - newer OpenClaw memory runtime and status surface.
- `src/adapters/openclaw/memory/flush-plan.ts` - deliberate pass-through flush-plan behavior.
- `src/adapters/openclaw/transcript/*.ts` - OpenClaw JSONL transcript normalization used by ingest and summaries.
- `src/adapters/db/openclaw-plugin-queries.ts` - OpenClaw-specific DB lookups for core-memory injection, trace, subject lookup, and status snapshots.
- `tests/adapters/openclaw/*.test.ts` and `tests/adapters/openclaw/session/*.test.ts` - coverage for config, runtime wiring, hooks, tools, transcript parsing, summaries, flush-plan behavior, and predecessor tracking.

## Important architectural nuance

The OpenClaw adapter is intentionally not a second memory brain.

Its job is to translate OpenClaw runtime concepts into agenr core and adapter calls:

- tool calls become store, recall, update, retire, and trace operations
- session lifecycle hooks become continuity summary and prompt-injection work
- transcript JSONL becomes normalized agenr transcript input
- newer OpenClaw memory-slot status surfaces become thin status/probe adapters

Some current-runtime choices matter:

- shared services are created once per plugin process and reused across tools and hooks
- session-start prompt injection is narrow: it injects active `core` entries plus predecessor continuity, not a broad semantic recall pass
- predecessor continuity is file-based, using sidecar summary files next to transcript JSONL, not handoff entries stored back into agenr
- summary generation uses OpenClaw's embedded agent runner and the active OpenClaw agent model, not agenr's own LLM config
- embeddings still come from agenr config and are required for `agenr_recall`
- the newer memory runtime is mostly a status and capability bridge: `sync()` is a no-op and the flush-plan hook returns `null`

## Packaging

OpenClaw installs should use the plugin-only package:

```bash
openclaw plugins install @agenr/openclaw-plugin
openclaw gateway restart
```

The plugin id is still `agenr`, so:

- `plugins.entries.agenr`
- `plugins.slots.memory = "agenr"`
- `openclaw plugins update agenr`

all continue to use the same runtime identity.

For local development, run `pnpm build` from the repo root and point `plugins.load.paths` at the package root:

```json
{
  "plugins": {
    "load": { "paths": ["/path/to/agenr/packages/openclaw-plugin"] }
  }
}
```

## Plugin surface

### Manifest and config

The plugin manifest declares:

- plugin `id`: `agenr`
- plugin `kind`: `memory`
- tool contracts: `agenr_store`, `agenr_recall`, `agenr_retire`, `agenr_update`, `agenr_trace`

The runtime config is deliberately small:

- `dbPath` is an optional override
- `configPath` is an optional override
- unknown config keys are rejected

If OpenClaw provides `resolvePath`, the adapter resolves any supplied path overrides before startup. After that, `runtime.ts` loads agenr config via the same config/db resolution used by the CLI:

- `configPath` override if supplied
- otherwise `AGENR_CONFIG_PATH`
- otherwise `config.json` next to an overridden `dbPath`
- otherwise `~/.agenr/config.json`

The database path then resolves in this order:

- `dbPath` override if supplied
- otherwise `AGENR_DB_PATH`
- otherwise `dbPath` from agenr's config
- otherwise `~/.agenr/knowledge.db`

### Registration

`src/adapters/openclaw/index.ts` registers all adapter behavior in one place:

- one shared `servicesPromise`
- one per-process `SessionStartTracker`
- one static memory prompt-section builder
- optional memory flush-plan and memory runtime hooks when the host supports them
- five tools
- `before_prompt_build`
- `before_reset`
- `session_start`
- `gateway_stop`

On shutdown, `gateway_stop` awaits `services.close()` and ignores startup failures so shutdown stays best-effort.

## Shared runtime services

`createAgenrOpenClawServices()` builds the shared process-lifetime dependencies:

- a libSQL database adapter opened against `dbPath`
- an embedding client when agenr config provides credentials
- an always-throwing embedding port when embeddings are unavailable
- a recall adapter built from the database plus embedding port
- an embedding-status snapshot safe to expose to OpenClaw status surfaces

Embedding availability is resolved statically from config. There is no startup network probe.

That leads to an important split:

- `agenr_recall` checks `embeddingStatus.available` and fails early when embeddings are not configured
- session-start core-memory injection still works without embeddings because it reads `core` rows directly from the database

## Static prompt guidance

`buildAgenrMemoryPromptSection()` inserts the OpenClaw-facing instructions for when to use agenr.

Current behavior:

- if `agenr_recall` is unavailable, the section is omitted entirely
- otherwise it tells the model to call `agenr_recall` before answering questions about prior work, preferences, unfinished work, dates, or past sessions
- it includes explicit guidance for temporal recall using `since`, `until`, `around`, and `aroundRadius`
- it conditionally adds guidance for `agenr_store`, `agenr_update`, `agenr_retire`, and `agenr_trace` only when those tools are available
- it adds a citation rule based on `citationsMode`

This section is static guidance only. It does not inject memory results by itself.

## End-to-end flow

### 1. Session-start prompt injection

`before_prompt_build` is where the adapter injects memory and predecessor continuity into the OpenClaw prompt.

#### Duplicate suppression

The handler first asks `SessionStartTracker.consume(...)` whether this session has already received session-start recall.

Tracking rules today:

- `sessionId` wins when present
- otherwise `sessionKey` is used
- if neither is present, the handler treats the call as first-run

If the tracker reports a duplicate, the hook returns `undefined` and nothing is injected.

#### Core-memory recall

If this is the first run for the session, the adapter loads core entries through `listOpenClawCoreEntries(...)`.

Current session-start memory behavior is intentionally narrow:

- limit is fixed at `4`
- only active entries with `expiry = 'core'` qualify
- ordering is `importance DESC, created_at DESC`
- there is no session-start semantic query against non-core entries
- there is no embedding call in this path

The prompt formatter renders these entries under `## Agenr Session Recall` and `### Core Memory`.

#### Predecessor continuity lookup

The handler then tries to recover the immediately previous session for the same OpenClaw lane.

It resolves predecessors in this order:

1. use the in-process tracker record remembered during `before_reset`
2. if `session_start` provided `resumedFrom`, verify that it matches the remembered reset record
3. if tracker data is missing, fall back to scanning OpenClaw `sessions.json` for TUI single-lane sessions

The TUI fallback only applies to session keys shaped like `agent:<agentId>:<lane>` where the lane starts with `tui`. It normalizes UUID-suffixed lanes like `tui-<uuid>` back to a stable `tui` lane, filters to the same agent and lane family, excludes the current session, and picks the candidate with the newest `updatedAt`.

#### Previous-session summary loading

Once a predecessor session file is found, the adapter tries to load a sidecar summary from:

```text
<session-dir>/<session-id>.summary.md
```

If that file exists and is non-empty, it is injected under `## Previous session summary`.

If the file is missing, `before_prompt_build` may generate it on demand by calling `generateAndWriteOpenClawSessionSummary(...)`.

Important runtime details:

- read-time generation is wrapped in an outer `10_000 ms` timeout
- a timeout or generation failure is swallowed and results in no summary section
- if generation succeeds, the sidecar file is written and reused on later starts

#### Recent transcript tail

The adapter also parses the predecessor transcript and injects a compact tail under `## Recent session`.

Current limits:

- last `6` normalized transcript messages
- rendered as `U:` and `A:` lines
- capped to `1_800` characters

This recent-session section is a fallback continuity layer when the summary is missing or too lossy.

#### Final prompt mutation

The final `prependContext` is the concatenation of:

- previous-session summary, when available
- recent transcript tail, when available
- `Agenr Session Recall`, when any core entries exist

If all three are empty, the hook returns `undefined`.

Any unexpected failure in the whole hook is logged and swallowed so prompt building can continue.

### 2. Session reset and sidecar summary generation

`before_reset` is responsible for capturing outgoing-session continuity before OpenClaw clears the lane.

The hook does three things:

1. validate that `event.sessionFile` exists
2. remember the outgoing session file in `SessionStartTracker.rememberReset(...)`
3. try to write a sidecar summary next to that transcript

If `sessionFile` is missing, the hook logs a skip and returns.

#### Summary generation pipeline

`writeOpenClawSessionSummary()` is currently a thin wrapper around `generateAndWriteOpenClawSessionSummary(...)`.

That generation pipeline does the following:

1. derive `<session-id>.summary.md` from the transcript filename
2. parse the transcript through the OpenClaw transcript parser
3. drop empty normalized messages
4. skip the run when there are fewer than `4` cleaned messages
5. render a summary prompt from the cleaned transcript
6. cap transcript text to `14_000` characters while preserving both the start and end
7. resolve the OpenClaw agent, provider, and model from host config
8. call `runEmbeddedPiAgent(...)` with tools disabled and a `15_000 ms` timeout
9. strip a duplicated top-level Markdown heading from the response
10. write the normalized summary to the sidecar file

Two design choices matter here:

- the summary run uses OpenClaw's configured model and auth, not agenr's own LLM client
- the run uses a temporary session file under a temp directory and removes that directory afterward

Current skip and failure modes include:

- `missing_session_id`
- `empty`
- `too_short`
- `embedded_agent_unavailable`
- `already_exists`
- `empty_response`
- arbitrary thrown error text

### 3. OpenClaw tool behavior

The adapter registers five tools. All tool calls log an info-level summary plus sanitized parameters.

Sanitization is deliberate:

- store logs `contentLength`, not raw content
- retire logs `reasonLength`, not raw reason text
- recall logs the full query in params plus a truncated query in the summary

#### `agenr_store`

`agenr_store` is a thin tool wrapper over `storeEntriesDetailed(...)`.

Current runtime behavior:

- stores exactly one entry per tool call
- uses `openclaw-session:<sessionKey|sessionId|agentId|unknown>` as `source_file`
- defaults `source_context` to `Stored via agenr_store from OpenClaw.`
- returns `stored`, `skipped`, or `failed`
- resolves the stored entry again by subject so the tool can return `entryId` when possible

#### `agenr_recall`

`agenr_recall` calls the core `recall()` pipeline through the injected recall ports.

Supported request fields today:

- `query`
- `limit`
- `threshold`
- `types`
- `tags`
- `since`
- `until`
- `around`
- `aroundRadius`

Important details:

- `sessionKey` from the OpenClaw tool context is always attached for recall telemetry
- if embeddings are unavailable, the tool fails before calling core recall
- result text is a compact numbered list with ID, type, subject, score, importance, and truncated content
- structured tool details also include the full returned entry metadata

One current oddity is worth noting: the tool implementation still reads and logs an optional `project` field if it appears in raw params, but `project` is not part of the declared JSON schema and it is not passed through to core recall.

#### `agenr_update`

`agenr_update` mutates only:

- `importance`
- `expiry`

It requires exactly one target selector:

- `id`
- `subject`

and at least one update field.

#### `agenr_retire`

`agenr_retire` soft-deletes an entry by:

- `id`
- `subject`

An optional `reason` is stored as retirement metadata.

#### `agenr_trace`

`agenr_trace` exposes the limited v1 provenance view:

- the entry itself
- `superseded_by`
- entries it supersedes
- recent recall events

It accepts:

- `id`
- `subject`
- `last`

The `last` mode resolves the most recently created entry from any state.

#### Target resolution rules

The tool layer resolves targets with a few non-obvious semantics:

- callers must provide exactly one selector
- subject lookup is case-insensitive and exact matches rank above substring matches
- subject lookup returns the most recent match
- id and subject lookup can resolve inactive entries for trace and for mutation attempts
- update and retire still fail if the resolved entry is no longer active

### 4. Transcript parsing

The OpenClaw transcript parser is used by both ingest and continuity summary generation, so its filtering rules shape more than one runtime path.

Current parser behavior:

- accepts OpenClaw JSONL session exports
- ignores malformed JSONL lines but records warnings
- captures `sessionId`, normalized `conversation_label`, start timestamp, and `modelsUsed`
- normalizes roles into `user`, `assistant`, `toolResult`, `system`, or `unknown`
- drops system messages
- strips OpenClaw user metadata fence blocks before normalizing text
- drops pure base64-like blobs
- summarizes assistant tool calls into transcript-safe text
- either keeps, truncates, or replaces tool results with placeholders based on tool name and output length
- fills missing timestamps from session metadata, file mtime, or current time

Tool-result policy is intentionally opinionated:

- always drop raw results for tools like `read`, `web_fetch`, `browser`, `screenshot`, `snapshot`, `canvas`, `tts`, `agenr_recall`, and `image`
- keep some raw results, truncated, for tools like `web_search`, `memory_search`, and `memory_get`
- keep `exec` output only when it is short or looks like an error

This matters for continuity because sidecar summaries and recent transcript tails are built from the normalized transcript, not the raw JSONL.

### 5. Newer OpenClaw memory-slot bridge

The newer OpenClaw memory runtime integration is intentionally thin.

`createAgenrMemoryRuntime()` returns a runtime object that:

- reports backend `builtin`
- exposes provider status as `agenr`
- includes db path, embedding model, active-entry counts, core-entry counts, and source-file counts
- probes vector availability by calling `vector_top_k(...)` against agenr's vector index with a zero vector
- exposes embedding availability based on the already-resolved embedding status
- implements `sync()` as a no-op
- closes shared services from `closeAllMemorySearchManagers()`

`buildAgenrMemoryFlushPlan()` always returns `null`.

That means the plugin participates in OpenClaw's memory-slot APIs for status and runtime registration, but it does not take over transcript compaction or flush policy.

## Current testing coverage

The adapter has direct tests for:

- manifest-backed config parsing
- runtime config and embedding resolution
- prompt-section generation
- tool execution and logging
- transcript parsing and filtering
- session-start dedup and predecessor injection
- reset-time summary writing
- TUI predecessor fallback
- summary generation through the embedded OpenClaw runner
- session-state tracking
- pass-through flush-plan behavior

So the current docs above are backed by targeted adapter tests, not just manual inspection.
