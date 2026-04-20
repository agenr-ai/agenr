# Corpus-Backed Evals Implementation Spec

## Objective

Build a repeatable evaluation substrate for `agenr` that allows an agent like Codex to:

- run replay suites against a production-like corpus snapshot
- inspect detailed structured artifacts for failures and regressions
- patch the `agenr` codebase
- rerun targeted slices and full suites
- compare results over time

The same work should also provide an `agenr`-only debug log for live OpenClaw runs so runtime investigation does not depend on noisy host debug output.

## Facts And Constraints

### Existing facts

- The current eval seams are intentionally narrow and fixture-seeded.
- Recall already emits typed observational trace summaries.
- Before-turn already exposes app-layer diagnostics through its eval seam.
- OpenClaw integration is explicitly adapter-owned.
- The sandbox corpus is already large enough to create realistic distractor pressure.

### Hard constraints

- `src/core/` must stay pure and must not gain filesystem or process-global logging.
- Detailed logs are needed, but they must not pollute normal runtime output.
- Evals must never run directly against the source `knowledge.db`.
- The replay substrate should be useful both for human debugging and agent-driven iteration.

## Design Principles

1. One observability model, multiple sinks.
   - `core` produces trace summaries.
   - `app` shapes diagnostics.
   - `adapters` persist them to artifacts or JSONL.

2. Deterministic where possible, realistic where necessary.
   - Keep fixture evals for small deterministic regression coverage.
   - Add snapshot-backed replay for production-like retrieval pressure.

3. Debug detail should be structured, bounded, and opt-in.
   - Prefer JSON/JSONL artifacts over ad hoc `debug()` strings.
   - Cap top-K candidate dumps.

4. Agent usability is a first-class goal.
   - Artifacts need stable schemas, versioning, and enough data to explain failures without interactive reproduction.

## Target End State

The finished system has two complementary loops.

### Offline replay loop

- A copied corpus snapshot is used to seed each eval sandbox.
- Replay suites run against real retrieval pressure.
- Each failed case produces a stable structured artifact with routing, candidate counts, ranking facts, selected results, and capped top-K candidate details.
- `agenr-evals` can compare runs and cluster failures.

### Live OpenClaw debug loop

- When explicit debug config is enabled, OpenClaw writes `agenr`-only structured JSONL events to a separate file.
- The file captures recall and before-turn decisions without mixing in general host noise.
- Normal host logs remain concise.

## Architecture Split

### `src/core/`

Owns:

- recall behavior
- before-turn and session-start decision logic inputs and outputs
- typed recall trace summaries

Must not own:

- file writing
- JSONL logging
- eval artifact persistence
- OpenClaw-specific debug paths

### `src/app/`

Owns:

- eval sandbox orchestration
- fixture and snapshot provisioning
- diagnostics shaping
- response normalization

### `src/adapters/`

Owns:

- HTTP request validation and mapping
- snapshot-copy filesystem work
- JSONL debug sinks
- OpenClaw runtime logging integration
- any human-readable or structured runtime log persistence

### `agenr-evals`

Owns:

- manifests
- replay corpora
- run orchestration
- artifact comparison
- reporting and clustering

## Proposed Contracts

### Shared eval corpus-seed contract

Both recall and before-turn evals should adopt a shared seed contract.

```ts
export type EvalCorpusSeed =
  | { mode: "fixture" }
  | {
      mode: "snapshot_copy";
      snapshotDbPath: string;
      snapshotId?: string;
      snapshotLabel?: string;
      allowTelemetryWrites?: boolean;
    };
```

### Sandbox request

```ts
export interface RecallEvalSandboxRequest {
  root?: string;
  preserve?: boolean;
  corpusSeed?: EvalCorpusSeed;
}
```

Behavior:

- `fixture` preserves current behavior.
- `snapshot_copy` copies the snapshot DB into the case sandbox before execution.
- `memoryPool` and `procedurePool` remain optional overlays on top of the copied DB.
- `allowTelemetryWrites` defaults to `false`.
- Writes, when they occur, are confined to the copied DB.

### Eval debug options

```ts
export interface EvalDebugOptions {
  includeDiagnostics?: boolean;
  includeTimings?: boolean;
  includeDebugArtifact?: boolean;
  topKCandidates?: number;
}
```

Defaults:

- `includeDebugArtifact`: `false`
- `topKCandidates`: `10`
- hard max `topKCandidates`: `25`

### Replay artifact schemas

Replay artifacts should be versioned and stable.

Recall:

```ts
export interface RecallDebugArtifactV1 {
  schemaVersion: "recall-debug-artifact.v1";
  caseId: string;
  snapshot?: {
    id?: string;
    label?: string;
    dbPathBasename: string;
  };
  request: {
    recallPath: "core" | "unified";
    query: string;
  };
  routing?: unknown;
  candidateCounts?: unknown;
  ranking?: unknown;
  degraded?: unknown;
  selectedEntryIds: string[];
  topCandidates?: Array<{
    id: string;
    score: number;
    lexicalScore?: number;
    vectorScore?: number;
    recencyScore?: number;
    importanceScore?: number;
    reasons?: string[];
  }>;
}
```

Before-turn:

```ts
export interface BeforeTurnDebugArtifactV1 {
  schemaVersion: "before-turn-debug-artifact.v1";
  caseId: string;
  snapshot?: {
    id?: string;
    label?: string;
    dbPathBasename: string;
  };
  input: {
    trigger: string;
    currentTurnText: string;
  };
  queryPolicy?: unknown;
  queryVariants?: unknown;
  abstentionReasons?: string[];
  selectedEntryIds: string[];
  selectedProcedureKey: string | null;
  durableRecallTopCandidates?: Array<{
    id: string;
    score: number;
    reasons?: string[];
  }>;
  procedureTopCandidates?: Array<{
    procedureKey: string;
    score: number;
    reasons?: string[];
  }>;
}
```

## OpenClaw Debug Sink

### Goal

Create a dedicated `agenr` JSONL sink for live OpenClaw debugging.

### Config

Add a nested `debug` block to the OpenClaw plugin config.

```ts
debug?: {
  enabled?: boolean;
  logPath?: string;
  eventLevel?: "basic" | "detailed";
  perSessionFiles?: boolean;
  maxTopCandidates?: number;
}
```

Defaults:

- `enabled = false`
- `eventLevel = "basic"`
- `perSessionFiles = false`
- `maxTopCandidates = 10`

### Event model

```ts
export type AgenrDebugEvent =
  | {
      type: "tool_call";
      tool: string;
      sessionId?: string;
      sessionKey?: string;
      params: unknown;
    }
  | {
      type: "tool_result";
      tool: string;
      sessionId?: string;
      sessionKey?: string;
      summary: unknown;
    }
  | {
      type: "session_start_recall";
      sessionId?: string;
      sessionKey?: string;
      debug: unknown;
    }
  | {
      type: "before_turn_decision";
      sessionId?: string;
      sessionKey?: string;
      debug: BeforeTurnDebugArtifactV1;
    }
  | {
      type: "unified_recall";
      sessionId?: string;
      sessionKey?: string;
      debug: RecallDebugArtifactV1;
    }
  | {
      type: "continuity_resolution";
      sessionId?: string;
      sessionKey?: string;
      summary: unknown;
    }
  | {
      type: "error";
      sessionId?: string;
      sessionKey?: string;
      scope: string;
      error: { message: string };
    };
```

### Logging rules

- JSONL only.
- Adapter-owned only.
- No unbounded candidate dumps.
- No raw transcript payload dumps by default.
- Detailed candidate payloads only when detailed debug is enabled.

## File Ownership

### `agenr`

- `src/app/evals/recall/contracts.ts`
- `src/app/evals/before-turn/contracts.ts`
- `src/app/evals/recall/sandbox.ts`
- `src/app/evals/before-turn/*` sandbox reuse
- `src/app/evals/recall/normalize-response.ts`
- `src/app/evals/before-turn/normalize-response.ts`
- `src/adapters/api/validation/*`
- `src/app/openclaw/runtime.ts`
- `src/adapters/openclaw/config.ts`
- `src/adapters/openclaw/openclaw.plugin.json`
- `src/adapters/openclaw/debug/*`
- `src/adapters/openclaw/tools/recall.ts`
- `src/adapters/openclaw/hooks/before-prompt-build.ts`
- owning docs in `docs/`

### `agenr-evals`

- manifests for replay suites
- snapshot-aware shared context
- inspect/compare/report tooling
- failure clustering
- replay corpus authoring

## Milestone Map

1. Snapshot-backed recall evals
2. Snapshot-backed before-turn evals
3. Rich replay artifacts
4. OpenClaw `agenr` debug sink
5. Replay corpora and analysis tooling
6. Agent iteration runbook

## Success Criteria

- Replay evals can run against a copied real-corpus snapshot.
- Replay artifacts explain failure modes without re-running interactively.
- OpenClaw debug mode writes `agenr`-only JSONL to a separate file.
- `src/core/` stays free of filesystem and runtime logger concerns.
- Codex can use artifacts plus debug logs to iteratively improve `agenr`.
