/**
 * Core domain types for agenr.
 * These types have zero infrastructure dependencies.
 */

// ── Durable memory types ─────────────────────────────────────────────

/** Ordered list of supported durable memory kinds. */
const DURABLE_KINDS = ["fact", "decision", "preference", "lesson", "relationship", "milestone", "directive"] as const;
/**
 * Union of all supported durable memory kinds.
 */
export type DurableKind = (typeof DURABLE_KINDS)[number];

/** Ordered list of supported behavioral directive polarities. */
const DIRECTIVE_POLARITIES = ["abstain", "proactive"] as const;

/** Ordered list of non-topic behavioral directive triggers. */
const DIRECTIVE_BASE_TRIGGERS = ["session_start", "always"] as const;

/** Ordered list of supported explicit supersession relationships. */
const SUPERSESSION_KINDS = ["update", "correction", "duplicate", "duplicate_collapse", "merge", "refinement", "stale"] as const;

/** Ordered list of supported recall durability levels. */
const EXPIRY_LEVELS = ["core", "permanent", "temporary"] as const;

/** Ordered list of supported claim-key lifecycle statuses. */
const CLAIM_KEY_STATUSES = ["trusted", "tentative", "unresolved"] as const;

/** Ordered list of supported claim-key provenance sources. */
const CLAIM_KEY_SOURCES = [
  "manual",
  "model",
  "json_retry",
  "deterministic_repair",
  "dreaming_extract",
  "dreaming_reconcile",
  "dreaming_temporalize",
  "dreaming_project",
] as const;

/** Ordered list of supported claim-support provenance modes. */
const CLAIM_SUPPORT_MODES = ["explicit", "normalized", "inferred"] as const;

export {
  CLAIM_KEY_SOURCES,
  CLAIM_KEY_STATUSES,
  CLAIM_SUPPORT_MODES,
  DIRECTIVE_BASE_TRIGGERS,
  DIRECTIVE_POLARITIES,
  DURABLE_KINDS,
  EXPIRY_LEVELS,
  SUPERSESSION_KINDS,
};

/**
 * Union of all supported recall durability levels.
 */
export type Expiry = (typeof EXPIRY_LEVELS)[number];

/**
 * Union of all supported explicit supersession relationships.
 */
export type SupersessionKind = (typeof SUPERSESSION_KINDS)[number];

/**
 * Union of all supported claim-key lifecycle statuses.
 */
export type ClaimKeyStatus = (typeof CLAIM_KEY_STATUSES)[number];

/**
 * Union of all supported claim-key provenance sources.
 */
export type ClaimKeySource = (typeof CLAIM_KEY_SOURCES)[number];

/**
 * Union of all supported claim-support provenance modes.
 */
export type ClaimSupportMode = (typeof CLAIM_SUPPORT_MODES)[number];

/**
 * Union of supported directive polarity values.
 */
export type DirectivePolarity = (typeof DIRECTIVE_POLARITIES)[number];

/**
 * Supported directive trigger shape.
 */
export type DirectiveTrigger = (typeof DIRECTIVE_BASE_TRIGGERS)[number] | `topic:${string}`;

/** Ordered list of supported episode sources. */
const EPISODE_SOURCES = ["openclaw", "skeln", "codex", "cli", "synthesis"] as const;

/** Ordered list of supported episode activity levels. */
const EPISODE_ACTIVITY_LEVELS = ["substantial", "minimal", "none"] as const;

/** Ordered list of supported procedure step kinds. */
const PROCEDURE_STEP_KINDS = ["run_command", "read_reference", "inspect_state", "edit_file", "ask_user", "invoke_tool", "verify"] as const;

/** Ordered list of supported declarative procedure condition kinds. */
const PROCEDURE_CONDITION_KINDS = ["harness_is", "tool_available", "file_exists", "path_exists", "env_flag", "repo_state", "user_confirmed"] as const;

/** Ordered list of supported procedure provenance source kinds. */
const PROCEDURE_SOURCE_KINDS = ["skill", "doc", "durable", "episode", "repo_file", "manual"] as const;

export { EPISODE_ACTIVITY_LEVELS, EPISODE_SOURCES };
export { PROCEDURE_CONDITION_KINDS, PROCEDURE_SOURCE_KINDS, PROCEDURE_STEP_KINDS };

/**
 * Union of all supported episode sources.
 */
export type EpisodeSource = (typeof EPISODE_SOURCES)[number];

/**
 * Union of all supported episode activity levels.
 */
export type EpisodeActivityLevel = (typeof EPISODE_ACTIVITY_LEVELS)[number];

/**
 * Union of all supported procedure step kinds.
 */
export type ProcedureStepKind = (typeof PROCEDURE_STEP_KINDS)[number];

/**
 * Union of all supported procedure condition kinds.
 */
export type ProcedureConditionKind = (typeof PROCEDURE_CONDITION_KINDS)[number];

/**
 * Union of all supported procedure provenance source kinds.
 */
export type ProcedureSourceKind = (typeof PROCEDURE_SOURCE_KINDS)[number];

/**
 * Explicit lifecycle and provenance metadata attached to a stored claim key.
 */
export interface ClaimKeyLifecycleMetadata {
  claim_key_raw?: string;
  claim_key_status?: ClaimKeyStatus;
  claim_key_source?: ClaimKeySource;
  claim_key_confidence?: number;
  claim_key_rationale?: string;
  claim_support_source_kind?: string;
  claim_support_locator?: string;
  claim_support_observed_at?: string;
  claim_support_mode?: ClaimSupportMode;
}

/**
 * Canonical stored knowledge record.
 */
export interface Durable extends ClaimKeyLifecycleMetadata {
  id: string;
  type: DurableKind;
  subject: string;
  content: string;
  importance: number;
  expiry: Expiry;
  tags: string[];
  source_file?: string;
  source_context?: string;
  embedding?: number[];
  content_hash?: string;
  norm_content_hash?: string;
  quality_score: number;
  recall_count: number;
  last_recalled_at?: string;
  superseded_by?: string;
  valid_from?: string;
  valid_to?: string;
  directive_polarity?: DirectivePolarity;
  directive_trigger?: DirectiveTrigger;
  claim_key?: string;
  supersession_kind?: string;
  supersession_reason?: string;
  user_id?: string;
  project?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Mutable entry fields supported by direct update paths.
 *
 * Claim-key lifecycle updates are replacement-style, not merge-style. When any
 * lifecycle field is mutated, callers must provide one complete validated
 * lifecycle payload for the target claim key. Partial lifecycle patches are
 * rejected at the persistence boundary.
 */
export interface DurableUpdateInput {
  importance?: Durable["importance"];
  expiry?: Durable["expiry"];
  claim_key?: Durable["claim_key"];
  claim_key_raw?: Durable["claim_key_raw"];
  claim_key_status?: Durable["claim_key_status"];
  claim_key_source?: Durable["claim_key_source"];
  claim_key_confidence?: Durable["claim_key_confidence"];
  claim_key_rationale?: Durable["claim_key_rationale"];
  claim_support_source_kind?: Durable["claim_support_source_kind"];
  claim_support_locator?: Durable["claim_support_locator"];
  claim_support_observed_at?: Durable["claim_support_observed_at"];
  claim_support_mode?: Durable["claim_support_mode"];
  valid_from?: Durable["valid_from"];
  valid_to?: Durable["valid_to"];
  project?: Durable["project"];
}

/**
 * Canonical stored episodic-memory record.
 */
export interface Episode {
  id: string;
  source: EpisodeSource;
  sourceId?: string;
  sourceRef?: string;
  transcriptHash?: string;
  summaryHash?: string;
  agentId?: string;
  surface?: string;
  startedAt: string;
  endedAt?: string;
  summary: string;
  tags: string[];
  activityLevel?: EpisodeActivityLevel;
  userId?: string;
  project?: string;
  genModel?: string;
  genVersion?: string;
  messageCount?: number;
  embedding?: number[];
  validFrom?: string;
  validTo?: string;
  supersessionKind?: string;
  supersessionReason?: string;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Procedure types ──────────────────────────────────────────────────

/**
 * Explicit authored provenance attached to a procedure or reference step.
 */
export interface ProcedureSource {
  kind: ProcedureSourceKind;
  path?: string;
  locator?: string;
  label?: string;
}

/**
 * Closed JSON-like value space accepted by `invoke_tool.arguments`.
 */
export type ProcedureToolArgumentValue = string | number | boolean | null | { [key: string]: ProcedureToolArgumentValue } | ProcedureToolArgumentValue[];

/**
 * Condition that scopes a step to one supported harness value.
 */
export interface ProcedureHarnessCondition {
  kind: "harness_is";
  value: string;
}

/**
 * Condition that scopes a step to one available tool name.
 */
export interface ProcedureToolAvailableCondition {
  kind: "tool_available";
  value: string;
}

/**
 * Condition that requires one exact file path to exist.
 */
export interface ProcedureFileExistsCondition {
  kind: "file_exists";
  path: string;
}

/**
 * Condition that requires one path to exist.
 */
export interface ProcedurePathExistsCondition {
  kind: "path_exists";
  path: string;
}

/**
 * Condition that checks one environment flag by name and optional value.
 */
export interface ProcedureEnvFlagCondition {
  kind: "env_flag";
  name: string;
  value?: string;
}

/**
 * Condition that checks one bounded repository-state marker.
 */
export interface ProcedureRepoStateCondition {
  kind: "repo_state";
  value: string;
}

/**
 * Condition that requires one explicit user confirmation token.
 */
export interface ProcedureUserConfirmedCondition {
  kind: "user_confirmed";
  value: string;
}

/**
 * Supported bounded declarative condition union for procedure steps.
 */
export type ProcedureCondition =
  | ProcedureHarnessCondition
  | ProcedureToolAvailableCondition
  | ProcedureFileExistsCondition
  | ProcedurePathExistsCondition
  | ProcedureEnvFlagCondition
  | ProcedureRepoStateCondition
  | ProcedureUserConfirmedCondition;

/**
 * Shared authored fields carried by every normalized procedure step.
 */
export interface ProcedureStepBase {
  id: string;
  kind: ProcedureStepKind;
  instruction: string;
  conditions?: ProcedureCondition[];
  stop_if?: ProcedureCondition[];
}

/**
 * Step that records one shell command to run.
 */
export interface ProcedureRunCommandStep extends ProcedureStepBase {
  kind: "run_command";
  command: string;
}

/**
 * Step that points readers at an external reference.
 */
export interface ProcedureReadReferenceStep extends ProcedureStepBase {
  kind: "read_reference";
  ref: ProcedureSource;
}

/**
 * Step that asks the agent to inspect current state before continuing.
 */
export interface ProcedureInspectStateStep extends ProcedureStepBase {
  kind: "inspect_state";
  target?: string;
  query?: string;
}

/**
 * Step that describes one file edit in human-readable terms.
 */
export interface ProcedureEditFileStep extends ProcedureStepBase {
  kind: "edit_file";
  path: string;
  edit: string;
}

/**
 * Step that asks the agent to collect input from the user.
 */
export interface ProcedureAskUserStep extends ProcedureStepBase {
  kind: "ask_user";
  prompt: string;
}

/**
 * Step that invokes a structured tool with optional arguments.
 */
export interface ProcedureInvokeToolStep extends ProcedureStepBase {
  kind: "invoke_tool";
  tool: string;
  arguments?: { [key: string]: ProcedureToolArgumentValue };
}

/**
 * Step that checks whether the procedure completed successfully.
 */
export interface ProcedureVerifyStep extends ProcedureStepBase {
  kind: "verify";
  checks: string[];
}

/**
 * Supported authored procedure-step union.
 */
export type ProcedureStep =
  | ProcedureRunCommandStep
  | ProcedureReadReferenceStep
  | ProcedureInspectStateStep
  | ProcedureEditFileStep
  | ProcedureAskUserStep
  | ProcedureInvokeToolStep
  | ProcedureVerifyStep;

/**
 * Canonical normalized procedure body stored in `body_json`.
 */
export interface ProcedureDefinition {
  procedure_key: string;
  title: string;
  goal: string;
  when_to_use: string[];
  when_not_to_use: string[];
  prerequisites: string[];
  steps: ProcedureStep[];
  verification: string[];
  failure_modes: string[];
  sources: ProcedureSource[];
}

/**
 * Lifecycle and revision metadata stored alongside a procedure revision.
 */
export interface ProcedureLifecycleMetadata {
  recall_text: string;
  revision_hash: string;
  source_hash: string;
  valid_from?: string;
  valid_to?: string;
  supersession_kind?: string;
  supersession_reason?: string;
  superseded_by?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Canonical stored procedural-memory record.
 */
export interface Procedure extends ProcedureDefinition, ProcedureLifecycleMetadata {
  id: string;
  source_file?: string;
  embedding?: number[];
}

// ── Store types ──────────────────────────────────────────────────────

/**
 * User-supplied fields for storing a new entry.
 *
 * The store pipeline still derives claim-key status, source, confidence, and
 * rationale. Callers may additionally preserve raw/support metadata when an
 * explicit claim key came from a trusted transcript or tool-call path.
 */
export interface StoreDurableInput {
  type: DurableKind;
  subject: string;
  content: string;
  importance?: number;
  expiry?: Expiry;
  tags?: string[];
  source_file?: string;
  source_context?: string;
  user_id?: string;
  project?: string;
  created_at?: string;
  supersedes?: string;
  claim_key?: string;
  claim_key_raw?: string;
  claim_key_status?: Durable["claim_key_status"];
  claim_key_source?: Durable["claim_key_source"];
  claim_key_confidence?: Durable["claim_key_confidence"];
  claim_key_rationale?: Durable["claim_key_rationale"];
  claim_support_source_kind?: string;
  claim_support_locator?: string;
  claim_support_observed_at?: string;
  claim_support_mode?: ClaimSupportMode;
  valid_from?: string;
  valid_to?: string;
  directive_polarity?: DirectivePolarity;
  directive_trigger?: DirectiveTrigger;
}

/**
 * Summary of a store operation outcome.
 */
export interface StoreResult {
  stored: number;
  skipped: number;
  rejected: number;
}

// ── Ingestion types ──────────────────────────────────────────────────

/**
 * Normalized transcript message emitted by transcript adapters.
 */
export interface TranscriptMessage {
  index: number;
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
}

/**
 * Session-level metadata derived while parsing a transcript file.
 */
export interface SessionTranscriptMetadata {
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  messageCount: number;
  transcriptHash: string;
}

/**
 * Parsed transcript metadata exposed to transcript consumers.
 */
export interface ParsedTranscriptMetadata extends SessionTranscriptMetadata {
  sessionLabel?: string;
  modelsUsed?: string[];
  /** Best-effort surface reconstructed from transcript content. */
  reconstructedSurface?: string | null;
  /** Provenance for the reconstructed surface value. */
  surfaceReconstructionSource?: "reconstructed" | "none";
  /** Stable source identity derived by the transcript adapter when available. */
  sourceIdentity?: string;
  /** Adapter-specific kind describing the stable source identity. */
  sourceIdentityKind?: string;
  /** Best-effort working-directory or workspace path for the session. */
  workingDirectory?: string;
  /** Explicit user identifier carried by the transcript source when available. */
  userId?: string;
  /** Explicit project identifier carried by the transcript source when available. */
  project?: string;
}

/**
 * Chunk of transcript text prepared for extraction or summarization.
 */
export interface TranscriptChunk {
  chunk_index: number;
  text: string;
  message_range: [number, number];
}

/**
 * Parsed transcript with normalized messages and source metadata.
 */
export interface ParsedTranscript {
  messages: TranscriptMessage[];
  metadata: ParsedTranscriptMetadata;
  warnings: string[];
}
