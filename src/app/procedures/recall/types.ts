import type { CrossEncoderPort, ProcedureDatabasePort } from "../../../core/ports.js";
import type { Procedure } from "../../../core/types.js";

/**
 * Optional MMR diversification controls plumbed through to procedure recall.
 */
export interface ProcedureMmrOptions {
  /** Whether to diversify the procedure shortlist with MMR. */
  enabled: boolean;
  /** Optional lambda override in the inclusive 0-1 range. */
  lambda?: number;
  /**
   * Optional minimum pool-size gate forwarded to the shared MMR helper.
   * Defaults to the core `DEFAULT_MMR_MIN_POOL_SIZE` when unset; `0`
   * disables the gate so MMR runs on every non-empty shortlist.
   */
  minPoolSize?: number;
}

/**
 * Optional cross-encoder rerank controls plumbed through to procedure recall.
 *
 * Unified recall wires this whenever a cross-encoder port is available
 * and the ranking policy leaves the stage enabled. The helper fails
 * closed on provider errors, so a broken cross-encoder cannot drop
 * procedure recall below its pre-rerank baseline.
 */
export interface ProcedureCrossEncoderOptions {
  /** Whether to run the cross-encoder rerank stage. */
  enabled: boolean;
  /** Cross-encoder adapter to invoke when the stage is enabled. */
  port: CrossEncoderPort;
  /** Optional top-K shortlist override. */
  topK?: number;
  /** Optional blend alpha override in the inclusive 0-1 range. */
  alpha?: number;
}

/**
 * Agent-facing request for the dedicated procedure recall pipeline.
 */
export interface ProcedureRecallInput {
  /** Free-form procedure recall query text. */
  text: string;
  /** Maximum ranked candidates to return. */
  limit?: number;
  /** Minimum score required for a canonical procedure answer. */
  threshold?: number;
  /** Optional MMR diversification knobs applied to the procedure shortlist. */
  mmr?: ProcedureMmrOptions;
  /** Optional cross-encoder rerank knobs applied to the procedure shortlist. */
  crossEncoder?: ProcedureCrossEncoderOptions;
}

/**
 * Ranked procedure candidate surfaced by dedicated procedure recall.
 */
export interface ProcedureRecallCandidate {
  /** Hydrated stored procedure revision. */
  procedure: Procedure;
  /** Final combined ranking score in the 0-1 range. */
  score: number;
  /** Score components retained for later shaping and diagnostics. */
  scores: {
    /** Fused reciprocal rank fusion relevance signal across vector and lexical channels. */
    relevance: number;
    /** Alias of `relevance` that makes the RRF origin explicit in traces. */
    rrf: number;
    /** Evidence-only lexical overlap score computed from title and recall text. */
    lexical: number;
    /** Evidence-only vector similarity score when semantic retrieval is available. */
    vector: number;
    /**
     * Raw cross-encoder score in the 0-1 range when the rerank stage
     * produced one for this candidate. Absent when the candidate fell
     * outside the shortlist, when the stage was disabled, or when the
     * provider failed.
     */
    crossEncoder?: number;
  };
}

/**
 * Final result returned by the dedicated procedure recall pipeline.
 */
export interface ProcedureRecallResult {
  /**
   * Canonical top procedure when the leading candidate clears score and
   * separation thresholding.
   */
  canonicalProcedure?: Procedure;
  /** Ranked candidates preserved for later unified-recall integration. */
  candidates: ProcedureRecallCandidate[];
  /** Stable degraded-mode or fallback notices relevant to the caller. */
  notices: string[];
}

/**
 * Dependencies needed by dedicated procedure recall.
 */
export interface ProcedureRecallDeps {
  /** Procedure query port backed by the database adapter. */
  db: ProcedureDatabasePort;
  /**
   * Optional semantic embedding helper. When absent or failing, procedure
   * recall falls back to lexical-only ranking.
   */
  embedQuery?: (text: string) => Promise<number[]>;
}
