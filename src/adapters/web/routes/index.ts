import type { WebRoute } from "../router.js";
import { buildDreamingRoutes } from "./dreaming-routes.js";
import { buildInstanceRoutes, buildSelectedInstanceRoute } from "./instance-routes.js";
import { buildMemoryRoutes } from "./memory-routes.js";
import { buildProcedureRoutes } from "./procedure-routes.js";
import { buildProposalRoutes } from "./proposal-routes.js";

/**
 * Aggregates every web API route into a single ordered table.
 *
 * @returns The complete route table for the operator console API.
 */
export function buildWebRoutes(): WebRoute[] {
  return [
    buildSelectedInstanceRoute(),
    ...buildInstanceRoutes(),
    ...buildDreamingRoutes(),
    ...buildProposalRoutes(),
    ...buildMemoryRoutes(),
    ...buildProcedureRoutes(),
  ];
}
