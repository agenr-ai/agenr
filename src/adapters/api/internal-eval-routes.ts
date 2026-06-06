import type { CrossEncoderPort } from "../../core/ports.js";
import { createInternalBeforeTurnEvalRoute } from "./routes/internal-before-turn-eval.js";
import { createInternalDreamingEfficiencyEvalRoute } from "./routes/internal-dreaming-efficiency-eval.js";
import { createInternalRecallEvalRoute } from "./routes/internal-recall-eval.js";
import { createInternalSessionStartEvalRoute } from "./routes/internal-session-start-eval.js";
import type { InternalApiRoute } from "./internal-api-route.js";

/**
 * Construction options shared by the internal eval route set.
 */
export interface InternalEvalRoutesOptions {
  /**
   * Optional cross-encoder port forwarded to both the recall and
   * before-turn routes so phase 4 rerank is exercised through the HTTP
   * seam. Omitting the port leaves both pipelines wired exactly as
   * before and lets the durable-recall trace record
   * `degradedReason: "not_configured"` for each route.
   */
  crossEncoder?: CrossEncoderPort;
}

/**
 * Creates the complete internal eval route set served by the local dev server.
 *
 * @param options - Optional dependencies forwarded into individual routes.
 * @returns Stable internal eval routes in deterministic order.
 */
export function createInternalEvalRoutes(options: InternalEvalRoutesOptions = {}): InternalApiRoute[] {
  return [
    createInternalRecallEvalRoute({ crossEncoder: options.crossEncoder }),
    createInternalBeforeTurnEvalRoute({ crossEncoder: options.crossEncoder }),
    createInternalSessionStartEvalRoute(),
    createInternalDreamingEfficiencyEvalRoute(),
  ];
}
