/**
 * Core domain types for agenr.
 * These types have zero infrastructure dependencies.
 */

// ── Entry types ──────────────────────────────────────────────────────

/** Ordered list of supported durable knowledge entry categories. */
const ENTRY_TYPES = ["fact", "decision", "preference", "lesson", "relationship", "milestone"] as const;
/**
 * Union of all supported knowledge entry categories.
 */
export type EntryType = (typeof ENTRY_TYPES)[number];

/** Ordered list of supported explicit supersession relationships. */
const SUPERSESSION_KINDS = ["update", "correction", "duplicate", "merge", "refinement"] as const;

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
  "surgeon_metadata_rewrite",
  "surgeon_family_reuse",
  "surgeon_compaction",
] as const;

/** Ordered list of supported claim-support provenance modes. */
const CLAIM_SUPPORT_MODES = ["explicit", "normalized", "inferred"] as const;

export { CLAIM_KEY_SOURCES, CLAIM_KEY_STATUSES, CLAIM_SUPPORT_MODES, ENTRY_TYPES, EXPIRY_LEVELS, SUPERSESSION_KINDS };

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

/** Ordered list of supported episode sources. */
const EPISODE_SOURCES = ["openclaw", "codex", "cli", "synthesis"] as const;

/** Ordered list of supported episode activity levels. */
const EPISODE_ACTIVITY_LEVELS = ["substantial", "minimal", "none"] as const;

export { EPISODE_ACTIVITY_LEVELS, EPISODE_SOURCES };

/**
 * Union of all supported episode sources.
 */
export type EpisodeSource = (typeof EPISODE_SOURCES)[number];

/**
 * Union of all supported episode activity levels.
 */
export type EpisodeActivityLevel = (typeof EPISODE_ACTIVITY_LEVELS)[number];

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
export interface Entry extends ClaimKeyLifecycleMetadata {
  id: string;
  type: EntryType;
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
  claim_key?: string;
  supersession_kind?: string;
  supersession_reason?: string;
  cluster_id?: string;
  user_id?: string;
  project?: string;
  retired: boolean;
  retired_at?: string;
  retired_reason?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Mutable entry fields supported by direct update paths.
 *
 * Direct update callers may set claim-key lifecycle fields when they are
 * preserving an explicit high-intent manual key outside the main store path.
 */
export interface EntryUpdateInput {
  importance?: Entry["importance"];
  expiry?: Entry["expiry"];
  claim_key?: Entry["claim_key"];
  claim_key_raw?: Entry["claim_key_raw"];
  claim_key_status?: Entry["claim_key_status"];
  claim_key_source?: Entry["claim_key_source"];
  claim_key_confidence?: Entry["claim_key_confidence"];
  claim_key_rationale?: Entry["claim_key_rationale"];
  claim_support_source_kind?: Entry["claim_support_source_kind"];
  claim_support_locator?: Entry["claim_support_locator"];
  claim_support_observed_at?: Entry["claim_support_observed_at"];
  claim_support_mode?: Entry["claim_support_mode"];
  valid_from?: Entry["valid_from"];
  valid_to?: Entry["valid_to"];
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
  retired: boolean;
  retiredAt?: string;
  retiredReason?: string;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Store types ──────────────────────────────────────────────────────

/**
 * User-supplied fields for storing a new entry.
 *
 * The store pipeline still derives claim-key status, source, confidence, and
 * rationale. Callers may additionally preserve raw/support metadata when an
 * explicit claim key came from a trusted transcript or tool-call path.
 */
export interface StoreEntryInput {
  type: EntryType;
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
  claim_key_status?: Entry["claim_key_status"];
  claim_key_source?: Entry["claim_key_source"];
  claim_key_confidence?: Entry["claim_key_confidence"];
  claim_key_rationale?: Entry["claim_key_rationale"];
  claim_support_source_kind?: string;
  claim_support_locator?: string;
  claim_support_observed_at?: string;
  claim_support_mode?: ClaimSupportMode;
  valid_from?: string;
  valid_to?: string;
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
