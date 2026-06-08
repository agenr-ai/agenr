import {
  listDurables,
  listEpisodes,
  listProcedures,
  loadDurableDetail,
  loadMemoryFacets,
} from "../../../app/web/memory-browser-service.js";
import {
  closeWebDurableValidity,
  storeWebDurable,
  supersedeWebDurable,
  updateWebDurableMetadata,
} from "../../../app/web/memory-lifecycle-service.js";
import type { DurableListResult, DurableTrace, EpisodeListResult, MemoryFacets, Procedure } from "../../../web-api/types.js";
import { WebApiError } from "../api-error.js";
import type { JsonRouteResult, WebRequestContext, WebRoute } from "../router.js";
import {
  parseCloseValidityBody,
  parseDurableListQuery,
  parseEpisodeListQuery,
  parseStoreDurableBody,
  parseUpdateMetadataBody,
} from "../validation/requests.js";
import { requireInstanceScope } from "./instance-scope.js";

/** Number of procedures returned to the read-side procedure list. */
const PROCEDURE_LIST_LIMIT = 200;

/**
 * Builds the Memory Explorer read and lifecycle-mutation routes.
 *
 * @returns Memory route definitions.
 */
export function buildMemoryRoutes(): WebRoute[] {
  return [
    { kind: "json", method: "GET", pattern: "/api/web/durables", handler: listDurablesHandler },
    { kind: "json", method: "POST", pattern: "/api/web/durables", handler: storeDurableHandler },
    { kind: "json", method: "GET", pattern: "/api/web/durables/:id", handler: durableDetailHandler },
    { kind: "json", method: "POST", pattern: "/api/web/durables/:id/supersede", handler: supersedeDurableHandler },
    { kind: "json", method: "POST", pattern: "/api/web/durables/:id/metadata", handler: updateMetadataHandler },
    { kind: "json", method: "POST", pattern: "/api/web/durables/:id/retire", handler: retireDurableHandler },
    { kind: "json", method: "GET", pattern: "/api/web/memory/facets", handler: facetsHandler },
    { kind: "json", method: "GET", pattern: "/api/web/episodes", handler: listEpisodesHandler },
    { kind: "json", method: "GET", pattern: "/api/web/procedures", handler: listProceduresHandler },
  ];
}

/** Lists durables for the operator browser with structured filters. */
async function listDurablesHandler(ctx: WebRequestContext): Promise<JsonRouteResult<DurableListResult>> {
  const scope = await requireInstanceScope(ctx);
  const query = parseDurableListQuery(ctx.url.searchParams);
  const result = await listDurables({ ...query, context: scope.context });
  return { status: 200, body: result };
}

/** Stores a brand-new durable through the shared store pipeline. */
async function storeDurableHandler(ctx: WebRequestContext): Promise<JsonRouteResult<{ durableId: string | null; backupPath: string | null }>> {
  const scope = await requireInstanceScope(ctx, { embedding: true });
  const { durable } = parseStoreDurableBody(await ctx.readJson());

  try {
    const result = await storeWebDurable({ durable, context: scope.context, embedding: scope.embedding! });
    return { status: 201, body: result };
  } catch (error) {
    throw new WebApiError(400, "invalid_request", error instanceof Error ? error.message : String(error));
  }
}

/** Returns the full trace detail for one durable. */
async function durableDetailHandler(ctx: WebRequestContext): Promise<JsonRouteResult<DurableTrace>> {
  const scope = await requireInstanceScope(ctx);
  const trace = await loadDurableDetail({ id: ctx.params.id, context: scope.context });
  if (!trace) {
    throw WebApiError.notFound(`Unknown durable: ${ctx.params.id}.`);
  }

  return { status: 200, body: trace };
}

/** Supersedes the durable named in the path with a new successor. */
async function supersedeDurableHandler(ctx: WebRequestContext): Promise<JsonRouteResult<{ durableId: string | null; backupPath: string | null }>> {
  const scope = await requireInstanceScope(ctx, { embedding: true });
  const { durable } = parseStoreDurableBody(await ctx.readJson());

  try {
    const result = await supersedeWebDurable({
      durable,
      supersedesId: ctx.params.id,
      context: scope.context,
      embedding: scope.embedding!,
    });
    return { status: 201, body: result };
  } catch (error) {
    throw new WebApiError(400, "invalid_request", error instanceof Error ? error.message : String(error));
  }
}

/** Updates metadata-only fields on a durable. */
async function updateMetadataHandler(ctx: WebRequestContext): Promise<JsonRouteResult<{ updated: boolean; backupPath: string | null }>> {
  const scope = await requireInstanceScope(ctx);
  const fields = parseUpdateMetadataBody(await ctx.readJson());

  try {
    const result = await updateWebDurableMetadata({ id: ctx.params.id, fields, context: scope.context });
    if (!result.updated) {
      throw WebApiError.notFound(`Unknown durable: ${ctx.params.id}.`);
    }
    return { status: 200, body: result };
  } catch (error) {
    if (error instanceof WebApiError) {
      throw error;
    }
    throw new WebApiError(400, "invalid_request", error instanceof Error ? error.message : String(error));
  }
}

/** Retires a durable by closing its valid-time window. */
async function retireDurableHandler(ctx: WebRequestContext): Promise<JsonRouteResult<{ updated: boolean; backupPath: string | null }>> {
  const scope = await requireInstanceScope(ctx);
  const { reason } = parseCloseValidityBody(await ctx.readJson());

  const result = await closeWebDurableValidity({
    id: ctx.params.id,
    ...(reason ? { reason } : {}),
    context: scope.context,
  });
  if (!result.updated) {
    throw WebApiError.notFound(`Unknown or already-retired durable: ${ctx.params.id}.`);
  }

  return { status: 200, body: result };
}

/** Returns claim-key facet suggestions for the explorer filters. */
async function facetsHandler(ctx: WebRequestContext): Promise<JsonRouteResult<MemoryFacets>> {
  const scope = await requireInstanceScope(ctx);
  const facets = await loadMemoryFacets({ context: scope.context });
  return { status: 200, body: facets };
}

/** Lists recent episodes for the read-side browser. */
async function listEpisodesHandler(ctx: WebRequestContext): Promise<JsonRouteResult<EpisodeListResult>> {
  const scope = await requireInstanceScope(ctx);
  const query = parseEpisodeListQuery(ctx.url.searchParams);
  const result = await listEpisodes({ ...query, context: scope.context });
  return { status: 200, body: result };
}

/** Lists active procedures for the read-side browser. */
async function listProceduresHandler(ctx: WebRequestContext): Promise<JsonRouteResult<{ procedures: Procedure[] }>> {
  const scope = await requireInstanceScope(ctx);
  const procedures = await listProcedures({ limit: PROCEDURE_LIST_LIMIT, context: scope.context });
  return { status: 200, body: { procedures } };
}
