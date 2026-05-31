import type { BeforeTurnPatchDiagnostics } from "../before-turn/index.js";

/**
 * Default top-K candidate cap applied when a before-turn debug
 * artifact is requested without supplying an explicit override.
 */
const BEFORE_TURN_DEBUG_ARTIFACT_DEFAULT_TOP_K = 10;

/**
 * Hard upper bound for the before-turn debug-artifact top-K candidate
 * list. Builders clamp any larger in-process request defensively so
 * artifacts stay bounded and predictable for agent consumers.
 */
const BEFORE_TURN_DEBUG_ARTIFACT_MAX_TOP_K = 25;

export { BEFORE_TURN_DEBUG_ARTIFACT_DEFAULT_TOP_K, BEFORE_TURN_DEBUG_ARTIFACT_MAX_TOP_K };

/**
 * Stable schema version tag for the before-turn replay debug artifact.
 */
export type BeforeTurnDebugArtifactSchemaVersion = "before-turn-debug-artifact.v1";

/**
 * Snapshot provenance block included in a before-turn debug artifact
 * when the sandbox was seeded from a copied corpus snapshot.
 */
export interface BeforeTurnDebugArtifactSnapshot {
  /** Optional stable snapshot identifier echoed from the request. */
  id?: string;
  /** Optional human-readable snapshot label echoed from the request. */
  label?: string;
  /** Base filename of the source snapshot DB, never a full path. */
  dbPathBasename: string;
}

/**
 * Compact turn summary preserved inside the before-turn debug artifact.
 */
export interface BeforeTurnDebugArtifactInputSummary {
  /** Host-provided trigger hint, or `unspecified` when omitted. */
  trigger: string;
  /** Current user-turn text preserved for replay analysis. */
  currentTurnText: string;
}

/**
 * Bounded durable-recall candidate breakdown for the before-turn debug artifact.
 */
export interface BeforeTurnDebugArtifactDurableCandidate {
  /** Stable durable entry identifier. */
  id: string;
  /** Final durable-memory score for the candidate. */
  score: number;
  /** Concise reasons explaining why the candidate surfaced. */
  reasons?: string[];
}

/**
 * Bounded procedure candidate breakdown for the before-turn debug artifact.
 */
export interface BeforeTurnDebugArtifactProcedureCandidate {
  /** Canonical procedure key for the candidate. */
  procedureKey: string;
  /** Final leader score from dedicated procedure recall. */
  score: number;
  /** Concise reasons explaining why the procedure surfaced. */
  reasons?: string[];
}

/**
 * Bounded, versioned debug artifact surfaced by before-turn paths.
 * Aligned with the recall artifact contract so one replay tool can
 * consume artifacts from either eval seam or the OpenClaw live sink.
 */
export interface BeforeTurnDebugArtifactV1 {
  /** Stable schema version for this artifact payload. */
  schemaVersion: BeforeTurnDebugArtifactSchemaVersion;
  /** Stable case identifier echoed from the request for correlation. */
  caseId: string;
  /** Optional snapshot provenance when the sandbox was snapshot-seeded. */
  snapshot?: BeforeTurnDebugArtifactSnapshot;
  /** Compact turn summary preserved for offline diagnosis. */
  input: BeforeTurnDebugArtifactInputSummary;
  /** Query-policy decision surfaced by the before-turn selector. */
  queryPolicy?: NonNullable<BeforeTurnPatchDiagnostics["queryPolicy"]>;
  /** Actual durable-query variants attempted during selection. */
  queryVariants?: BeforeTurnPatchDiagnostics["queryVariants"];
  /** Stable abstention reasons mirrored from diagnostics. */
  abstentionReasons?: string[];
  /** Ranked durable entry IDs returned by the selector. */
  selectedEntryIds: string[];
  /** Selected canonical procedure key when one surfaced, otherwise null. */
  selectedProcedureKey: string | null;
  /** Optional bounded durable-recall top-K candidate breakdown. */
  durableRecallTopCandidates?: BeforeTurnDebugArtifactDurableCandidate[];
  /** Optional bounded procedure top-K candidate breakdown. */
  procedureTopCandidates?: BeforeTurnDebugArtifactProcedureCandidate[];
}
