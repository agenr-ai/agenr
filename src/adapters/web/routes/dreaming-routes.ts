import { loadDreamActionsRuntime, loadDreamHistoryRuntime, loadDreamProposalsRuntime } from "../../../app/dreaming/runtime.js";
import { loadCockpitSnapshot } from "../../../app/web/health-service.js";
import type { CockpitSnapshot, DreamJobSnapshot, DreamRunsResponse } from "../../../web-api/types.js";
import { WebApiError } from "../api-error.js";
import type { JsonRouteResult, WebRequestContext, WebRoute } from "../router.js";
import type { SseConnection } from "../sse.js";
import { parseDreamStartBody } from "../validation/requests.js";
import { requireDreamJobForInstance, requireInstanceScope } from "./instance-scope.js";

/** Number of persisted runs returned to the Dreaming Runs view. */
const RUN_HISTORY_LIMIT = 30;

/**
 * Builds the Ops Cockpit and dreaming-run routes.
 *
 * @returns Cockpit and dreaming route definitions.
 */
export function buildDreamingRoutes(): WebRoute[] {
  return [
    { kind: "json", method: "GET", pattern: "/api/web/cockpit", handler: cockpitHandler },
    { kind: "json", method: "GET", pattern: "/api/web/dream/runs", handler: listRunsHandler },
    { kind: "json", method: "POST", pattern: "/api/web/dream/runs", handler: startRunHandler },
    { kind: "json", method: "GET", pattern: "/api/web/dream/runs/:runId/actions", handler: runActionsHandler },
    { kind: "json", method: "GET", pattern: "/api/web/dream/runs/:runId/proposals", handler: runProposalsHandler },
    { kind: "json", method: "GET", pattern: "/api/web/dream/jobs/:jobId", handler: jobHandler },
    { kind: "json", method: "POST", pattern: "/api/web/dream/jobs/:jobId/cancel", handler: cancelJobHandler },
    { kind: "sse", method: "GET", pattern: "/api/web/dream/jobs/:jobId/stream", handler: jobStreamHandler },
  ];
}

/** Returns the aggregate cockpit snapshot for the selected instance. */
async function cockpitHandler(ctx: WebRequestContext): Promise<JsonRouteResult<CockpitSnapshot>> {
  const scope = await requireInstanceScope(ctx);
  const snapshot = await loadCockpitSnapshot({ dbPath: scope.dbPath, env: ctx.env });
  return { status: 200, body: snapshot };
}

/** Lists persisted run history plus the live in-process job window. */
async function listRunsHandler(ctx: WebRequestContext): Promise<JsonRouteResult<DreamRunsResponse>> {
  const scope = await requireInstanceScope(ctx);
  const history = await loadDreamHistoryRuntime({ dbPath: scope.dbPath, env: ctx.env, limit: RUN_HISTORY_LIMIT });
  const jobs = ctx.coordinator.listJobs(scope.instance.record.id);
  return { status: 200, body: { history, jobs } };
}

/** Starts a UI-initiated dreaming run and returns the initial job snapshot. */
async function startRunHandler(ctx: WebRequestContext): Promise<JsonRouteResult<DreamJobSnapshot>> {
  const scope = await requireInstanceScope(ctx);
  const body = parseDreamStartBody(await ctx.readJson());

  const active = ctx.coordinator.getActiveJob(scope.instance.record.id);
  if (active) {
    throw new WebApiError(409, "conflict", "A dreaming run is already in progress for this instance.");
  }

  const snapshot = ctx.coordinator.start({
    tier: body.tier,
    apply: body.apply,
    ...(body.project ? { project: body.project } : {}),
    dbPath: scope.dbPath,
    instanceId: scope.instance.record.id,
    env: ctx.env,
  });

  return { status: 202, body: snapshot };
}

/** Returns the action audit trail for one persisted run. */
async function runActionsHandler(ctx: WebRequestContext): Promise<JsonRouteResult<{ actions: Awaited<ReturnType<typeof loadDreamActionsRuntime>> }>> {
  const scope = await requireInstanceScope(ctx);
  const actions = await loadDreamActionsRuntime({ runId: ctx.params.runId, dbPath: scope.dbPath, env: ctx.env });
  return { status: 200, body: { actions } };
}

/** Returns the unresolved-proposal trail for one persisted run. */
async function runProposalsHandler(ctx: WebRequestContext): Promise<JsonRouteResult<{ proposals: Awaited<ReturnType<typeof loadDreamProposalsRuntime>> }>> {
  const scope = await requireInstanceScope(ctx);
  const proposals = await loadDreamProposalsRuntime({ runId: ctx.params.runId, dbPath: scope.dbPath, env: ctx.env });
  return { status: 200, body: { proposals } };
}

/** Returns a single live job snapshot. */
async function jobHandler(ctx: WebRequestContext): Promise<JsonRouteResult<DreamJobSnapshot>> {
  const scope = await requireInstanceScope(ctx, { database: false });
  const job = requireDreamJobForInstance(ctx.coordinator, ctx.params.jobId, scope.instance.record.id);
  return { status: 200, body: job };
}

/** Requests cancellation of an in-flight job. */
async function cancelJobHandler(ctx: WebRequestContext): Promise<JsonRouteResult<{ cancelled: boolean }>> {
  const scope = await requireInstanceScope(ctx, { database: false });
  requireDreamJobForInstance(ctx.coordinator, ctx.params.jobId, scope.instance.record.id);
  const cancelled = ctx.coordinator.cancel(ctx.params.jobId);
  if (!cancelled) {
    throw new WebApiError(409, "conflict", "Job is not running or does not exist.");
  }

  return { status: 200, body: { cancelled: true } };
}

/** Terminal job statuses that should end the SSE stream once observed. */
const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted"]);

/** Streams a job's buffered and live events over server-sent events. */
async function jobStreamHandler(ctx: WebRequestContext, stream: SseConnection): Promise<void> {
  const scope = await requireInstanceScope(ctx, { database: false });
  requireDreamJobForInstance(ctx.coordinator, ctx.params.jobId, scope.instance.record.id);

  const subscription = ctx.coordinator.subscribe(ctx.params.jobId, (event) => {
    stream.send(event.kind, event);
    if (event.kind === "status" && event.status && TERMINAL_STATUSES.has(event.status)) {
      stream.send("end", { status: event.status });
      stream.close();
    }
  });
  if (!subscription) {
    stream.send("error", { message: `Unknown dreaming job: ${ctx.params.jobId}.` });
    stream.close();
    return;
  }

  stream.onClose(() => subscription.unsubscribe());

  for (const event of subscription.replay) {
    stream.send(event.kind, event);
  }

  // A job that already finished before the client subscribed must still end.
  const snapshot = ctx.coordinator.getJob(ctx.params.jobId);
  if (snapshot && TERMINAL_STATUSES.has(snapshot.status)) {
    stream.send("end", { status: snapshot.status });
    subscription.unsubscribe();
    stream.close();
  }
}
