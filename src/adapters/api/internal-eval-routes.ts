import { createInternalBeforeTurnEvalRoute } from "./routes/internal-before-turn-eval.js";
import { createInternalRecallEvalRoute } from "./routes/internal-recall-eval.js";
import type { InternalApiRoute } from "./internal-api-route.js";

/**
 * Creates the complete internal eval route set served by the local dev server.
 *
 * @returns Stable internal eval routes in deterministic order.
 */
export function createInternalEvalRoutes(): InternalApiRoute[] {
  return [createInternalRecallEvalRoute(), createInternalBeforeTurnEvalRoute()];
}
