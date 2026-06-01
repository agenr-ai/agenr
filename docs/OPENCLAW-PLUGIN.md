# OpenClaw Plugin

`src/adapters/openclaw/` is agenr's production OpenClaw integration.
The publishable package lives in `packages/openclaw-plugin` and ships as `@agenr/agenr-plugin`.
The OpenClaw plugin id remains `agenr`, so runtime identity and config keys stay stable.

This document describes the current codebase, not an aspirational design.

## What the plugin does today

The OpenClaw plugin is a translator around agenr's existing core and app workflows. It currently does all of the following:

- registers agenr as an OpenClaw memory plugin
- exposes six agent tools: `agenr_store`, `agenr_recall`, `agenr_fetch`, `agenr_update`, `agenr_retire`, and `agenr_trace`
- injects session-start context into the prompt from agenr core memory plus predecessor continuity
- tracks mid-session memory activity and can inject `[MEMORY CHECK]` nudges after long gaps without memory actions
- generates or reuses predecessor continuity summaries from OpenClaw transcript JSONL files
- writes predecessor sessions into agenr episodic memory in the background
- exposes OpenClaw memory-runtime status and vector/embedding probes
- reuses the OpenClaw transcript parser for continuity and episode ingestion

The adapter is intentionally not a second memory brain. Durable memory, recall ranking, episode ingest, and claim-key lifecycle still live in agenr core and app layers.

## Code map

- `src/adapters/openclaw/index.ts` - plugin entry, hook registration, tool registration, memory-runtime wiring, and shutdown cleanup.
- `src/adapters/openclaw/openclaw.plugin.json` and `src/adapters/openclaw/config.ts` - manifest-backed config schema, validation, UI hints, and store-nudge defaults.
- `packages/openclaw-plugin/package.json`, `packages/openclaw-plugin/openclaw.plugin.json`, and `packages/openclaw-plugin/src/index.ts` - publishable plugin package metadata and entrypoint.
- `src/app/plugin-runtime/` - shared host plugin memory composition: path resolution, DB open, embeddings, recall, session-start and before-turn deps, and close lifecycle reused by OpenClaw and Skeln.
- `src/app/openclaw/contract.ts` and `src/app/openclaw/types.ts` - canonical OpenClaw plugin config and composed service types.
- `src/app/openclaw/runtime.ts` - OpenClaw-specific runtime composition: debug sink, OpenClaw-authenticated claim extraction, and wiring into `plugin-runtime`.
- `src/app/session-start/` - host-neutral session-start patch contract and selection service.
- `src/app/before-turn/` - host-neutral before-turn patch contract and selection service.
- `src/app/memory/ports.ts` - host-neutral read-model contracts for trace and memory status.
- `src/adapters/openclaw/runtime.ts` - thin re-export of the app-owned runtime composition function.
- `src/adapters/db/session-start-repository.ts` - DB-backed session-start repository for always-on core-memory lookup.
- `src/adapters/openclaw/tools/` - one file per OpenClaw tool plus shared parsing, logging, and target-resolution helpers.
- `src/adapters/openclaw/format/prompt-section.ts` - static system-prompt doctrine for memory recall and storage.
- `src/adapters/openclaw/format/recall-format.ts` - session-start recall rendering.
- `src/adapters/openclaw/format/before-turn-format.ts` - before-turn recall rendering.
- `src/adapters/openclaw/format/nudge-format.ts` - mid-session `[MEMORY CHECK]` prompt generation.
- `src/adapters/openclaw/debug/` - adapter-owned JSONL debug sink (opt-in), event types, and live artifact builders shared with the eval seams.
- `src/adapters/openclaw/hooks/before-prompt-build.ts` - session-start recall, before-turn recall, predecessor continuity injection, background predecessor episode write, and mid-session store nudge logic.
- `src/adapters/openclaw/hooks/after-tool-call.ts` - mid-session tracker updates after `agenr_store`, `agenr_update`, and `agenr_retire`.
- `src/app/plugin-runtime/session-tracking.ts` - in-process session-start dedup shared by host plugins.
- `src/adapters/openclaw/session/state.ts` - per-session mid-session store-nudge state.
- `src/adapters/openclaw/session/continuity/` - predecessor resolution, continuity summary read/write, and recent-session tail rendering.
- `src/adapters/openclaw/session/session-key-parser.ts`, `src/adapters/openclaw/session/session-id.ts`, `src/adapters/openclaw/session/session-registry.ts`, `src/adapters/openclaw/session/transcript-files.ts`, `src/adapters/openclaw/session/sessions-store-reader.ts`, and `src/adapters/openclaw/session/tui-lane.ts` - OpenClaw session identity and continuity helpers.
- `src/adapters/openclaw/episode/episode-writer.ts` - best-effort predecessor episode ingest backed by the shared `app/episode-ingest` workflow.
- `src/adapters/openclaw/llm/openclaw-llm-client.ts` - lightweight OpenClaw-authenticated LLM client used for continuity, episode summaries, and optional claim extraction.
- `src/adapters/openclaw/memory/runtime.ts` and `src/adapters/openclaw/memory/flush-plan.ts` - thin memory-runtime bridge and no-op flush-plan behavior.
- `src/adapters/openclaw/transcript/` - OpenClaw JSONL parsing, cleanup, timestamp repair, tool summarization, and transcript-safe filtering.
- `src/adapters/db/memory-repository.ts` - DB-backed host-neutral memory repository for trace, subject lookup, and status probes.

## Packaging and identity

Install the plugin package, not the main CLI package:

```bash
openclaw plugins install @agenr/agenr-plugin
openclaw gateway restart
```

The runtime plugin id is still `agenr`, so existing OpenClaw references remain:

- `plugins.entries.agenr`
- `plugins.slots.memory = "agenr"`
- `openclaw plugins update agenr`

For local development, build from the repo root and point OpenClaw at the package directory:

```json
{
  "plugins": {
    "load": { "paths": ["/path/to/agenr/packages/openclaw-plugin"] }
  }
}
```

## Manifest and config

The plugin manifest declares:

- `id: "agenr"`
- `kind: "memory"`
- tool contracts for `agenr_store`, `agenr_recall`, `agenr_fetch`, `agenr_retire`, `agenr_update`, and `agenr_trace`

The runtime config is currently:

- `dbPath` - optional DB path override
- `configPath` - optional agenr config path override
- `continuityModel` - optional `provider/model` override for continuity summary generation
- `episodeModel` - optional `provider/model` override for predecessor episode summaries
- `claimExtractionModel` - optional `provider/model` override for claim-key extraction during store calls
- `storeNudge` - optional nested config with `enabled`, `threshold`, and `maxPerSession`
- `memoryPolicy.beforeTurn.enabled` - optional toggle for the proactive before-turn patch path
- `memoryPolicy.beforeTurn.procedureSuggestion` - optional toggle for the before-turn procedure section
- `memoryPolicy.beforeTurn.maxDurableEntries` - optional normal durable-item cap for before-turn recall
- `memoryPolicy.beforeTurn.recallThreshold` - optional durable-recall score floor for before-turn recall
- `memoryPolicy.beforeTurn.highConfidenceRecallThreshold` - optional score floor required before before-turn recall can expand beyond the normal durable-item cap
- `memoryPolicy.beforeTurn.procedureThreshold` - optional score floor for proactive procedure suggestion
- `memoryPolicy.slotPolicies.attributeHeads` - optional attribute-head overrides for read-time claim-slot policy classes
- `debug` - optional opt-in JSONL debug sink for `agenr`-only live events

Unknown keys are rejected.

Current `debug` defaults when unset:

- `enabled = false`
- `logPath = <openclaw-state-dir>/agenr/logs/debug.jsonl` when enabled and no explicit path is supplied
- `eventLevel = "basic"`
- `perSessionFiles = false`
- `maxTopCandidates = 10` (bounded to 25)

Current `storeNudge` defaults:

- `enabled = true`
- `threshold = 8`
- `maxPerSession = 5`

Path resolution still follows the shared agenr config rules:

1. plugin `configPath`, if set
2. `AGENR_CONFIG_PATH`
3. `config.json` next to an overridden `dbPath`
4. `~/.agenr/config.json`

Then DB resolution is:

1. plugin `dbPath`, if set
2. `AGENR_DB_PATH`
3. `dbPath` from agenr config
4. `~/.agenr/knowledge.db`

If OpenClaw provides `resolvePath`, the plugin resolves supplied path overrides through it before startup.

## Registration lifecycle

`src/adapters/openclaw/index.ts` registers one shared process-lifetime services promise plus one session-start tracker and one mid-session tracker.

The plugin currently wires:

- `registerMemoryCapability({ promptBuilder, flushPlanResolver, runtime })`
- the five tools
- `before_prompt_build`
- `session_start`
- `after_tool_call`
- `session_end`
- `gateway_stop`

Current lifecycle behavior:

- `session_start` only remembers `resumedFrom` by new `sessionId`
- `before_prompt_build` performs session-start patch selection once per tracked session identity
- repeated `before_prompt_build` calls for the same session can inject a before-turn patch or store nudges instead of session-start memory
- `after_tool_call` updates mid-session tracker state after memory tool use
- `session_end` clears mid-session state
- `gateway_stop` awaits `services.close()` and ignores startup failures during shutdown

## Shared runtime services

`createAgenrOpenClawServices()` in `src/app/openclaw/runtime.ts` builds the shared services used by tools, hooks, and memory status.

Current composition includes:

- the libSQL database adapter
- the OpenClaw-specific repository read model
- the app-layer session-start dependency bundle
- the app-layer before-turn dependency bundle
- an embedding client when embedding config is valid
- an always-throwing embedding port when embeddings are unavailable
- the recall adapter used by unified recall
- an optional claim-extraction runtime backed by OpenClaw auth and model resolution
- a public embedding-status snapshot safe for OpenClaw runtime surfaces

Important current behavior:

- embedding availability is resolved from config without a startup network probe
- `agenr_recall` stays available even when embeddings are unavailable and can degrade entry recall into lexical-only mode
- session-start core-memory injection does not need embeddings
- before-turn procedure suggestion degrades to lexical-only ranking when query embeddings are unavailable
- claim extraction is only wired when agenr claim-extraction config is enabled and the OpenClaw LLM client can be created

## Static prompt guidance

`buildAgenrMemoryPromptSection()` inserts static guidance into the OpenClaw system prompt.

It is only included when `agenr_recall` is available.

Current guidance covers:

- always call `agenr_recall` before answering questions about prior work, decisions, preferences, dates, unfinished work, or past sessions
- `mode=entries` for exact durable facts and decisions
- `mode=auto` for normal recall and historical-state questions such as "what was the previous approach"
- `mode=episodes` for explicit session-narrative recall
- put time phrases directly in the recall query for temporal questions
- memory authority ordering: durable entries, then episodes, then continuity/handoffs, then live verification
- automatically injected Agenr memory is background context, not user text, and should be used silently when relevant
- storage doctrine, type boundaries, and what not to store when `agenr_store` is available
- fix contradicted memory with `agenr_update` or `agenr_retire`
- use `agenr_trace` for provenance or supersession questions
- avoid overstating unfinished delegated work when non-memory orchestration tools are present
- citation behavior based on `citationsMode`

This section is static doctrine only. It does not itself recall memory or inject session-start results.

## Session flow

### 1. Session-start recall

`before_prompt_build` asks `SessionStartTracker.consume(...)` whether this is the first prompt-build for the current session identity.

Tracking rules today:

- `sessionId` wins when present
- otherwise `sessionKey` is used
- if neither is present, the call is treated as first-run

On the first run, the hook:

1. resolves predecessor continuity
2. starts a best-effort background predecessor episode write
3. calls the app-layer `runSessionStart(...)` service with normalized predecessor artifacts plus bounded policy hints
4. renders the returned structured patch into `prependContext`

Current session-start memory behavior is now a bounded hybrid patch:

- up to `4` always-on core entries are loaded through the feature-scoped session-start repository
- up to `3` additional durable candidates can be selected through artifact-grounded durable recall
- the final durable-memory set is capped to `5` items after dedupe and ranking
- durable memory stays visibly separate from predecessor continuity and transcript-tail context
- artifact-grounded recall runs only when a predecessor continuity summary or recent-session tail exists
- procedure suggestion is intentionally still out of scope for this session-start slice

The formatted prompt can include:

- `## Previous session summary`
- `## Recent session`
- `## Agenr Session Recall`
- `### Core Memory`
- `### Relevant Durable Memory`

Only the recalled durable-memory portion is fenced. Continuity sections stay outside the fence so they still read like restart context rather than recalled durable memory.

If all sections are empty, the hook returns `undefined`.

Any unexpected failure is logged and swallowed so prompt building can continue.

### Session-start ownership split

The hybrid session-start slice keeps the ownership boundary explicit:

- OpenClaw owns predecessor file discovery, transcript-tail extraction, lifecycle timing, prompt injection, and background predecessor-episode ingest.
- Agenr app code owns the bounded decision about which durable memories should surface at session start.
- The app service consumes normalized text artifacts and policy hints, then returns a structured patch rather than rendered prompt text.
- The adapter remains responsible for turning that patch into OpenClaw prompt sections.

### 2. Before-turn recall

When `before_prompt_build` is called again for an already-started session on a user-facing turn, the plugin can run the app-layer `runBeforeTurn(...)` service instead of repeating session-start recall.

Current behavior:

- the adapter derives input from the current prompt plus a compact recent-turn window from `event.messages`
- Agenr app code decides whether to surface anything at all
- durable memory comes from the shared entry `recall()` path
- at most one canonical procedure suggestion can surface through the dedicated procedure recall service
- the adapter skips short/social turns and other low-signal turns before injecting anything
- durable recall now defaults to a substantially stricter threshold and normally surfaces at most one durable item
- the durable section only expands beyond the normal cap when every surfaced item clears a very-high-confidence threshold
- the adapter renders recalled memory inside an `agenr-memory-context` fence so later prompt-building passes can strip it cleanly
- the adapter renders the result into a separate `## Agenr Before-Turn Recall` block with `### Relevant Durable Memory` and optional `### Suggested Procedure`
- non-user triggers `heartbeat`, `cron`, and `memory` still abstain
- empty or low-signal turns can abstain cleanly without injecting anything

Ownership split stays the same as session start:

- OpenClaw owns turn extraction, prompt injection, and trigger gating
- Agenr app code owns bounded ranking, abstention, claim-aware shaping, and procedure applicability decisions

### 3. Mid-session store nudges

When a non-first `before_prompt_build` call does not inject a before-turn patch, the plugin may still inject a `[MEMORY CHECK]` nudge.

Current nudge rules:

- no nudges for non-user triggers `heartbeat`, `cron`, or `memory`
- no nudges when `storeNudge.enabled` is false
- turns are counted per tracked session identity
- a nudge is eligible only after the configured gap since both the last successful store and the last memory action
- nudges stop after `maxPerSession`

Current nudge copy changes depending on:

- whether anything has been stored this session
- whether this is the first nudge
- whether this is the final allowed nudge
- the recent stored subjects, capped for display

The nudge is a prompt reminder only. It does not write memory on its own.

### 4. Mid-session tracker updates

`after_tool_call` updates the same per-session tracker after these tools:

- `agenr_store`
- `agenr_update`
- `agenr_retire`

Current behavior:

- successful `agenr_store` resets the successful-store and memory-action timers
- skipped `agenr_store` resets only memory-action timers
- `agenr_update` and `agenr_retire` reset memory-action timers
- explicit claim-bearing store attempts also update explicit-memory-action timing
- a bounded recent subject list is maintained for nudge copy

## Predecessor continuity

Continuity lives under `src/adapters/openclaw/session/continuity/`.

The resolver currently:

1. parses the current OpenClaw session key into a continuity identity
2. rejects ineligible session kinds early
3. resolves the agent-scoped sessions directory from OpenClaw runtime state
4. tries `session_start.resumedFrom` first
5. falls back to `sessions.json` scanning only for `main` and `tui`

Current continuity behavior:

- `resumedFrom` file discovery is preferred for all eligible session kinds
- `sessions.json` fallback is intentionally narrow and only used for `main` and `tui`
- missing or malformed `sessions.json` files are logged as explicit diagnostics and treated as an empty fallback source
- direct, group, and channel lanes accept a cold start when `resumedFrom` is missing or does not resolve
- ineligible kinds are ignored rather than forced through fallback logic

When a predecessor transcript is found, the plugin tries to build two prompt sections from it:

- a continuity summary
- a compact recent-session transcript tail

### Continuity summary read or generation

The adapter reads a sidecar summary at:

```text
<session-dir>/<session-id>.continuity-summary.md
```

If the sidecar exists and is non-empty, it is reused.

If it does not exist, `before_prompt_build` may trigger read-time generation through `generateAndWriteOpenClawContinuitySummary(...)`.

Current generation behavior:

- transcript comes from the OpenClaw JSONL parser, not raw file text
- empty cleaned transcripts are skipped
- transcripts with fewer than `4` cleaned messages are skipped
- prompt transcript text is capped at `14_000` characters while preserving both head and tail
- continuity generation uses the lightweight OpenClaw LLM client and OpenClaw auth, not agenr's own LLM config
- model selection prefers `continuityModel` and otherwise falls back to the active agent's primary model
- the generator has a `30_000 ms` timeout
- the session-start read path waits up to `35_000 ms` before giving up
- successful summaries are normalized and written back to the sidecar file for reuse

Current skip and failure reasons include:

- `missing_session_id`
- `empty`
- `too_short`
- `already_exists`
- `empty_response`
- `timeout`
- arbitrary error text

Failures are swallowed after logging so prompt build can proceed.

### Recent session tail

The adapter also renders a fallback transcript tail from the predecessor transcript:

- last `6` normalized messages
- rendered as `U:` and `A:` lines
- capped to `1_800` characters from the end

This uses the normalized transcript parser output, so system messages and large tool payloads have already been filtered.

## Background predecessor episode ingest

After predecessor resolution succeeds, `before_prompt_build` kicks off `writeOpenClawPredecessorEpisode(...)` without awaiting it.

This path is best-effort and never blocks prompt assembly.

Current behavior:

- routes through the shared `app/episode-ingest` workflow
- parses the predecessor transcript with the same OpenClaw transcript parser
- uses an OpenClaw-authenticated LLM client for summary generation
- prefers plugin `episodeModel` and otherwise falls back to the active agent model
- applies a `45_000 ms` overall timeout
- skips active-session checks because the predecessor is already known
- tries to embed the episode summary when embeddings are available and time budget remains
- logs skipped, invalid, failed, timed-out, created, or updated outcomes

This means the newest predecessor session can become episodic memory without a separate manual backfill step, but prompt continuity does not depend on that ingest succeeding.

## Tool behavior

The plugin registers six tools from `src/adapters/openclaw/tools/`.

All tool calls log info-level summaries plus sanitized params. Raw user content is not logged wholesale.

Current sanitization examples:

- store logs `contentLength`, not raw content
- retire logs `reasonLength`, not raw reason text
- recall logs the query for tool usefulness, but summary text stays compact

### `agenr_store`

`agenr_store` is a thin wrapper over `storeEntriesDetailed(...)`.

Current request fields:

- required: `type`, `subject`, `content`
- optional: `importance`, `expiry`, `tags`, `sourceContext`, `supersedes`, `claimKey`, `validFrom`, `validTo`

Current behavior:

- stores exactly one entry per call
- sets `source_file` to `openclaw-session:<sessionKey|sessionId|agentId|unknown>`
- defaults `source_context` to `Stored via agenr_store from OpenClaw.`
- can attach manual claim-support metadata when `claimKey` is supplied
- rejects invalid temporal bounds, including equal or reversed `validFrom` / `validTo`
- can also use the optional claim-extraction runtime when it is enabled
- returns `stored`, `skipped`, or `failed`
- resolves the stored subject again so the tool can return `entryId` when possible

### `agenr_recall`

`agenr_recall` calls `runUnifiedRecall()`.

Current request fields:

- required: `query`
- optional: `mode`, `limit`, `threshold`, `budget`, `types`, `tags`

Current behavior:

- attaches `sessionKey` for recall telemetry
- degrades entry recall into lexical-only mode when query embeddings or vector search fail
- supports unified routing across exact entry recall, historical-state recall, procedural recall, and episodic recall
- supports `mode=procedures` to force dedicated procedure recall
- returns routing metadata, rendered text, canonical procedure data, ranked procedure candidates, structured entry previews (not full bodies), claim-centric projected entry annotations, structured episode results, and notices
- entry previews are truncated in both text and structured details; use `agenr_fetch` for the full stored body
- groups entry output by claim family when `claim_key` is present and labels rows as `current`, `historical`, or `superseded`
- includes freshness, provenance, and `why_surfaced` cues in the human-readable text output
- uses `procedureNotices` and `notices` to surface degraded recall paths instead of silently hiding them

### `agenr_fetch`

`agenr_fetch` returns the full body and metadata for one durable entry.

Current target selectors:

- exactly one of `id` or `subject`

Current behavior:

- reuses the same id/subject resolution rules as `agenr_update` and `agenr_trace`
- returns full `content` in both tool text and structured details
- intended after `agenr_recall` when `preview_truncated=true` or exact stored wording is required

### `agenr_update`

`agenr_update` mutates an existing entry in place.

Current target selectors:

- exactly one of `id` or `subject`

Current update fields:

- `importance`
- `expiry`
- `claimKey`
- `validFrom`
- `validTo`

When `claimKey` is updated, the tool writes the shared normalized manual claim-key lifecycle bundle plus claim-support facts from the current OpenClaw session context.

When `validFrom` or `validTo` are updated, the tool applies the same strict range validation used by the core store path: both bounds must parse, and `validFrom` must be earlier than `validTo` when both are present.

### `agenr_retire`

`agenr_retire` soft-deletes an active entry.

Current request fields:

- exactly one of `id` or `subject`
- optional `reason`

Retired entries are excluded from recall.

### `agenr_trace`

`agenr_trace` exposes the current provenance view plus a narrow claim-family lineage view.

Current selectors:

- `id`
- `subject`
- `last`

Current trace payload includes:

- the entry itself
- `supersededBy`
- entries it supersedes
- same-claim-key family rows ordered for lineage inspection when `claim_key` exists, including the effective slot policy and policy reason
- recent recall events

### Shared target-resolution rules

The tool helper layer currently enforces these semantics:

- callers must provide exactly one selector
- subject lookup is case-insensitive
- exact matches rank ahead of substring matches
- the most recent matching entry wins
- trace can resolve inactive entries
- update and retire can resolve inactive entries for error reporting, but they still fail to mutate inactive entries

## Transcript parsing

The OpenClaw transcript parser is reused by continuity and predecessor episode ingest, so its filtering rules matter across several plugin features.

Current parser behavior:

- accepts OpenClaw JSONL session exports
- ignores malformed lines while recording warnings
- captures transcript metadata such as session id, conversation label, timestamps, and models used
- normalizes messages into adapter-safe roles
- drops system messages
- strips OpenClaw user metadata fence blocks before text normalization
- drops obvious base64-like blobs
- summarizes assistant tool calls into transcript-safe text
- truncates or replaces large tool results based on tool name and output shape
- repairs missing timestamps from transcript metadata, file metadata, or current time

Continuity summaries, recent-session tails, and predecessor episode ingest all operate on this normalized transcript output rather than raw JSONL.

## OpenClaw memory-runtime bridge

The newer OpenClaw memory-runtime integration remains intentionally thin.

`createAgenrMemoryRuntime()` currently reports:

- backend `builtin`
- provider `agenr`
- configured embedding model
- DB path
- source-file count
- active entry count
- core entry count
- vector dimensions
- vector availability probe result
- embedding availability probe result

Current runtime behavior:

- `sync()` is a no-op
- `resolveMemoryBackendConfig()` returns `{ backend: "builtin" }`
- `closeAllMemorySearchManagers()` closes the shared agenr services

`buildAgenrMemoryFlushPlan()` still returns `null`.

So agenr participates in OpenClaw's memory-runtime status surface, but it does not take over transcript compaction or flush policy.

## Current test coverage

The current adapter tests cover:

- config parsing and manifest-backed package metadata
- runtime wiring and embedding resolution
- static prompt-section generation
- tool behavior
- after-tool-call tracking
- session-start recall and mid-session nudge behavior
- predecessor resolution and continuity summary generation
- episode writer behavior
- session-state tracking
- session-registry and transcript-file helpers
- transcript parsing
- OpenClaw-authenticated LLM client behavior
- no-op flush-plan behavior

See `tests/adapters/openclaw/` for the current set of targeted plugin tests.

## Agenr debug sink

The OpenClaw plugin includes an opt-in JSONL debug sink dedicated to `agenr`-only events. It lives in `src/adapters/openclaw/debug/` and exists so detailed recall and before-turn decisions can be inspected without the noise of OpenClaw host debug logs.

Current behavior:

- the sink is always present in the shared services bundle, but returns a no-op when `debug.enabled` is false
- events are written to `debug.logPath` when set, or to `<openclaw-state-dir>/agenr/logs/debug.jsonl` otherwise
- writes are serialized per-process, fire-and-forget from call sites, and failures never propagate back into host paths
- `debug.perSessionFiles = true` appends a sanitized session id or session key to the log basename (for example `debug.alpha.jsonl`)
- `debug.eventLevel = "detailed"` admits bounded top-K candidate breakdowns into `unified_recall` and `before_turn_decision` events; `basic` omits them
- `debug.maxTopCandidates` caps the bounded breakdowns

Event families emitted today:

- `tool_call` and `tool_result` for `agenr_recall`
- `unified_recall` carrying the reusable `recall-debug-artifact.v1` live artifact
- `session_start_recall` with a compact session-start selection summary
- `before_turn_decision` carrying the reusable `before-turn-debug-artifact.v1` live artifact
- `continuity_resolution` summarizing predecessor continuity decisions
- `error` for scoped failures in recall, session-start, and before-turn paths

The sink is deliberately adapter-owned and bounded: `src/core/` never performs filesystem work, normal host logs remain concise, and detailed payloads stay bounded to the configured top-K caps.
