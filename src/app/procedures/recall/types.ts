import type { ProcedureDatabasePort } from "../../../core/ports.js";
import type { Procedure } from "../../../core/types.js";

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
    /** Blended relevance signal across lexical and vector evidence. */
    relevance: number;
    /** Lexical overlap score computed from title and recall text. */
    lexical: number;
    /** Vector similarity score when semantic retrieval is available. */
    vector: number;
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
