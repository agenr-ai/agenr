import type { BeforeTurnDebugArtifactV1, RecallDebugArtifactV1 } from "../../../app/debug-artifacts/index.js";

/**
 * Compact summary payload embedded in `session_start_recall` events.
 *
 * The live adapter emits a narrow summary rather than the full debug
 * artifact used by the eval seam because live session-start selection
 * does not surface a stable case identifier.
 */
export interface AgenrDebugSessionStartRecallSummary {
  /** Number of durable memory items surfaced at session start. */
  durableMemoryCount: number;
  /** Stable durable identifiers surfaced at session start, in output order. */
  selectedDurableIds: string[];
  /** Count of core candidates considered before merging. */
  coreCandidateCount: number;
  /** Count of artifact-grounded recall candidates considered before dedupe. */
  artifactRecallCandidateCount: number;
  /** Whether artifact-grounded recall was attempted. */
  artifactRecallUsed: boolean;
  /** Stable notices emitted during the session-start selection pass. */
  notices: string[];
}

/**
 * Compact summary payload embedded in `tool_result` events.
 *
 * Captures routing, selected durable ids, and notice state without
 * dumping raw candidate payloads.
 */
export interface AgenrDebugRecallToolResultSummary {
  /** Total number of results returned by the unified recall call. */
  count: number;
  /** Compact routing summary mirrored from the unified recall response. */
  routing: {
    requested: string;
    detectedIntent: string;
    queried: string[];
    reason: string;
  };
  /** Ranked durable identifiers in output order. */
  selectedDurableIds: string[];
  /** Ranked episode identifiers in output order. */
  episodeIds: string[];
  /** Selected canonical procedure key when one surfaced. */
  selectedProcedureKey: string | null;
  /** Stable notices surfaced by unified recall. */
  notices: string[];
  /** Procedure-specific notices surfaced by unified recall. */
  procedureNotices: string[];
}

/**
 * Discriminated union of structured agenr debug events written to the
 * adapter-owned JSONL sink.
 */
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
      summary: AgenrDebugRecallToolResultSummary | unknown;
    }
  | {
      type: "session_start_recall";
      sessionId?: string;
      sessionKey?: string;
      debug: AgenrDebugSessionStartRecallSummary;
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
      type: "error";
      sessionId?: string;
      sessionKey?: string;
      scope: string;
      error: { message: string };
    };

/**
 * Narrow event-type discriminator exposed for filtering utilities.
 */
export type AgenrDebugEventType = AgenrDebugEvent["type"];
