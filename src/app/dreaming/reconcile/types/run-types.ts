import type { AgenrConfig } from "../../../../config.js";
import type { DreamCompletionSummary, DreamRunStatus } from "../../../../core/dreaming/types.js";
import type { ClaimExtractionPreviewOutcome, ClaimExtractionResult } from "../../../../core/store/claim-extraction.js";
import type { LlmPort } from "../../../../core/ports.js";
import type { DreamTier } from "../../../../core/dreaming/domain/pass-types.js";
import type { DreamProgressReporter } from "../../progress.js";
import type { DreamPort } from "../../ports.js";

/**
 * Claim-key reconcile selection and execution options for one dreaming run.
 */
export interface ReconcileRunOptions {
  runId: string;
  tier: DreamTier;
  apply: boolean;
  project?: string;
  type?: string;
  claimKeyPrefix?: string;
  durableIds?: string[];
  includeInactive?: boolean;
  signal?: AbortSignal;
  now(): Date;
  costCapUsd: number;
  verbose: boolean;
  /** When true, records shadow sibling-slot resonance telemetry in pass summaries. */
  includeShadowTelemetry?: boolean;
  reportProgress?: DreamProgressReporter;
}

/**
 * Resolved dependencies required by the reconcile pass.
 */
export interface ReconcileRunDeps {
  port: DreamPort;
  config: AgenrConfig | null;
  createClaimExtractionLlm?: () => LlmPort & { metadata?: { usage?: { inputTokens?: number; outputTokens?: number; totalCost?: number } } };
}

/**
 * Final deterministic result returned by the reconcile pass.
 */
export interface ReconcileRunResult {
  status: DreamRunStatus;
  error: string | null;
  completion: DreamCompletionSummary;
  durablesRetired: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
}

export interface DurableSuggestionRecord {
  suggestion: ClaimExtractionResult | null;
  warnings: string[];
  previewOutcome: ClaimExtractionPreviewOutcome | null;
}

export type ClaimExtractionPreviewLlm = LlmPort & {
  metadata?: {
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalCost?: number;
    };
  };
};

export interface ReconcileSelection {
  includeInactive: boolean;
  project: string | null;
  type: string | null;
  claimKeyPrefix: string | null;
  durableIds: string[];
}
