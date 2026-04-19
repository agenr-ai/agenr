import type { CrossEncoderPort } from "../../core/ports.js";
import { createInternalBeforeTurnEvalRoute } from "./routes/internal-before-turn-eval.js";
import { createInternalRecallEvalRoute } from "./routes/internal-recall-eval.js";
import type { InternalApiRoute } from "./internal-api-route.js";

/**
 * Construction options shared by the internal eval route set.
 */
export interface InternalEvalRoutesOptions {
  /**
   * Optional cross-encoder port forwarded to the recall route so phase 4
   * rerank is exercised through the HTTP seam. Omitting the port leaves
   * the recall pipeline wired exactly as before.
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
  return [createInternalRecallEvalRoute({ crossEncoder: options.crossEncoder }), createInternalBeforeTurnEvalRoute()];
}
