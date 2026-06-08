import {
  readInstanceRegistry,
  registerInstance,
  removeInstance,
  resolveInstanceRecord,
  resolveSelectedInstance,
  selectInstance,
  type ResolvedWebInstance,
  type WebInstanceRecord,
} from "../../../app/web/instance-registry.js";
import type { InstancesResponse, InstanceView, SelectedInstanceResponse } from "../../../web-api/types.js";
import { WebApiError } from "../api-error.js";
import type { JsonRouteResult, WebRequestContext, WebRoute } from "../router.js";
import { parseRegisterInstanceBody } from "../validation/requests.js";

/**
 * Builds the instance-registry management routes.
 *
 * These routes are the only ones not scoped to a selected instance; they read
 * and mutate the local registry document itself.
 *
 * @returns Instance management route definitions.
 */
export function buildInstanceRoutes(): WebRoute[] {
  return [
    { kind: "json", method: "GET", pattern: "/api/web/instances", handler: listInstancesHandler },
    { kind: "json", method: "POST", pattern: "/api/web/instances", handler: registerInstanceHandler },
    { kind: "json", method: "POST", pattern: "/api/web/instances/:id/select", handler: selectInstanceHandler },
    { kind: "json", method: "DELETE", pattern: "/api/web/instances/:id", handler: removeInstanceHandler },
  ];
}

/** Lists registered instances with resolution diagnostics and the selection. */
async function listInstancesHandler(ctx: WebRequestContext): Promise<JsonRouteResult<InstancesResponse>> {
  const registry = await readInstanceRegistry(ctx.registryOptions);
  const instances = registry.instances.map((record) => toInstanceView(record, ctx.env));

  return {
    status: 200,
    body: {
      instances,
      selectedId: registry.selectedId ?? null,
    },
  };
}

/** Registers a new instance and returns the refreshed registry view. */
async function registerInstanceHandler(ctx: WebRequestContext): Promise<JsonRouteResult<InstancesResponse>> {
  const input = parseRegisterInstanceBody(await ctx.readJson());
  try {
    const registry = await registerInstance(input, ctx.registryOptions);
    const instances = registry.instances.map((record) => toInstanceView(record, ctx.env));
    return { status: 201, body: { instances, selectedId: registry.selectedId ?? null } };
  } catch (error) {
    throw new WebApiError(400, "invalid_request", error instanceof Error ? error.message : String(error));
  }
}

/** Selects an existing instance and returns the resolved selection. */
async function selectInstanceHandler(ctx: WebRequestContext): Promise<JsonRouteResult<SelectedInstanceResponse>> {
  try {
    const resolved = await selectInstance(ctx.params.id, ctx.registryOptions);
    return { status: 200, body: { selected: toResolvedView(resolved) } };
  } catch (error) {
    throw new WebApiError(404, "not_found", error instanceof Error ? error.message : String(error));
  }
}

/** Removes an instance and returns the refreshed registry view. */
async function removeInstanceHandler(ctx: WebRequestContext): Promise<JsonRouteResult<InstancesResponse>> {
  const registry = await removeInstance(ctx.params.id, ctx.registryOptions);
  const instances = registry.instances.map((record) => toInstanceView(record, ctx.env));
  return { status: 200, body: { instances, selectedId: registry.selectedId ?? null } };
}

/** Builds the currently-selected-instance route. */
export function buildSelectedInstanceRoute(): WebRoute {
  return {
    kind: "json",
    method: "GET",
    pattern: "/api/web/instance",
    handler: async (ctx): Promise<JsonRouteResult<SelectedInstanceResponse>> => {
      const selected = await resolveSelectedInstance(ctx.registryOptions);
      if (!selected) {
        return { status: 200, body: { selected: null } };
      }

      return { status: 200, body: { selected: toResolvedView(selected) } };
    },
  };
}

/** Resolves one record into a diagnostic view, capturing resolution errors. */
function toInstanceView(record: WebInstanceRecord, env: NodeJS.ProcessEnv): InstanceView {
  try {
    const resolved = resolveInstanceRecord(record, env);
    return {
      record,
      dbPath: resolved.dbPath,
      dbExists: resolved.dbExists,
      hasProceduresDir: resolved.proceduresDir !== undefined,
      error: null,
    };
  } catch (error) {
    return {
      record,
      dbPath: null,
      dbExists: false,
      hasProceduresDir: record.proceduresDir !== undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Projects a resolved instance into its serializable selection view. */
function toResolvedView(resolved: ResolvedWebInstance): InstanceView {
  return {
    record: resolved.record,
    dbPath: resolved.dbPath,
    dbExists: resolved.dbExists,
    hasProceduresDir: resolved.proceduresDir !== undefined,
    error: null,
  };
}
