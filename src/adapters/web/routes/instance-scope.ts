import { createInstanceContext, createInstanceEmbedding, type WebInstanceContext } from "../../../app/web/instance-context.js";
import { resolveSelectedInstance, type ResolvedWebInstance } from "../../../app/web/instance-registry.js";
import type { EmbeddingPort } from "../../../core/ports.js";
import { WebApiError } from "../api-error.js";
import type { WebRequestContext } from "../router.js";

/** Preconditions required before an instance-scoped route handler runs. */
export interface InstanceScopeNeeds {
  /** When true, require the resolved database file to exist. Defaults to true. */
  database?: boolean;
  /** When true, require a configured procedures directory. */
  proceduresDir?: boolean;
  /** When true, include a lazy embedding client for the instance. */
  embedding?: boolean;
}

/**
 * Resolved instance selection plus optional database, procedures, and embedding handles.
 */
export interface InstanceScope {
  /** Validated selected instance. */
  instance: ResolvedWebInstance;
  /** Shared runtime context for database and embedding resolution. */
  context: WebInstanceContext;
  /** Resolved database path. */
  dbPath: string;
  /** Configured procedures directory when requested. */
  proceduresDir?: string;
  /** Lazy embedding client when requested. */
  embedding?: EmbeddingPort;
}

/**
 * Resolves the currently selected instance for an instance-scoped route.
 *
 * @param ctx - Request context carrying registry options.
 * @returns The resolved, validated selected instance.
 * @throws {WebApiError} 409 when no instance is registered or selected.
 */
export async function requireSelectedInstance(ctx: WebRequestContext): Promise<ResolvedWebInstance> {
  let instance: ResolvedWebInstance | null;
  try {
    instance = await resolveSelectedInstance(ctx.registryOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WebApiError(409, "conflict", message);
  }

  if (!instance) {
    throw new WebApiError(409, "conflict", "No instance selected. Register and select an instance first.");
  }

  return instance;
}

/**
 * Resolves the selected instance and any requested scope preconditions.
 *
 * @param ctx - Request context carrying registry options and environment.
 * @param needs - Optional database, procedures-directory, and embedding requirements.
 * @returns Scoped handles for the selected instance.
 * @throws {WebApiError} 409 when a requested precondition is unmet.
 */
export async function requireInstanceScope(ctx: WebRequestContext, needs: InstanceScopeNeeds = {}): Promise<InstanceScope> {
  const requireDatabase = needs.database !== false;
  const instance = await requireSelectedInstance(ctx);
  const context = createInstanceContext(instance, ctx.env);
  const scope: InstanceScope = {
    instance,
    context,
    dbPath: requireDatabase ? requireExistingDatabase(instance) : instance.dbPath,
  };

  if (needs.proceduresDir) {
    scope.proceduresDir = requireProceduresDir(instance);
  }

  if (needs.embedding) {
    scope.embedding = createInstanceEmbedding(context);
  }

  return scope;
}

/**
 * Returns the configured procedures directory for an instance or fails.
 *
 * @param instance - Resolved instance to inspect.
 * @returns Absolute procedures directory path.
 * @throws {WebApiError} 409 when the instance has no procedures directory.
 */
export function requireProceduresDir(instance: ResolvedWebInstance): string {
  if (!instance.proceduresDir) {
    throw new WebApiError(409, "conflict", `Instance "${instance.record.name}" has no procedures directory configured.`);
  }

  return instance.proceduresDir;
}

/**
 * Returns the resolved database path for an instance or fails when missing.
 *
 * @param instance - Resolved instance to inspect.
 * @returns Database path usable by read and write services.
 * @throws {WebApiError} 409 when the instance database file does not exist.
 */
export function requireExistingDatabase(instance: ResolvedWebInstance): string {
  if (!instance.dbExists) {
    throw new WebApiError(409, "conflict", `Instance "${instance.record.name}" has no database yet. Run setup or ingest first.`);
  }

  return instance.dbPath;
}

/**
 * Returns a dreaming job snapshot when it belongs to the selected instance.
 *
 * @param coordinator - In-process dreaming coordinator.
 * @param jobId - Requested job id.
 * @param instanceId - Selected instance id.
 * @returns Cloned job snapshot.
 * @throws {WebApiError} 404 when the job is unknown or belongs to another instance.
 */
export function requireDreamJobForInstance(
  coordinator: WebRequestContext["coordinator"],
  jobId: string,
  instanceId: string,
): NonNullable<ReturnType<typeof coordinator.getJob>> {
  const job = coordinator.getJob(jobId);
  if (!job || job.instanceId !== instanceId) {
    throw WebApiError.notFound(`Unknown dreaming job: ${jobId}.`);
  }

  return job;
}
