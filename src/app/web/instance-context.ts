import { createDatabase, type SqlDatabase } from "../../adapters/db/client.js";
import { createEmbeddingClient, createLazyEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../adapters/embeddings.js";
import { readConfig, type ResolvedAgenrConfig } from "../../config.js";
import type { EmbeddingPort } from "../../core/ports.js";
import type { ResolvedWebInstance } from "./instance-registry.js";

/**
 * Resolved runtime handles for one selected instance shared across services.
 *
 * Holds only resolution inputs and lazy factories; opening a database is an
 * explicit per-operation concern so a single long-lived web process never
 * leaks SQLite handles across requests.
 */
export interface WebInstanceContext {
  /** Backing resolved instance record and paths. */
  instance: ResolvedWebInstance;
  /** Resolved configuration for the instance. */
  config: ResolvedAgenrConfig;
  /** Resolved database path. */
  dbPath: string;
  /** Environment map used for downstream resolution. */
  env: NodeJS.ProcessEnv;
}

/**
 * Builds a runtime context for the selected instance.
 *
 * @param instance - Resolved instance from the registry.
 * @param env - Environment map used for config and credential resolution.
 * @returns Runtime context shared by the web services.
 */
export function createInstanceContext(instance: ResolvedWebInstance, env: NodeJS.ProcessEnv = process.env): WebInstanceContext {
  const config = readConfig({
    env,
    ...(instance.record.configPath ? { configPath: instance.record.configPath } : {}),
    ...(instance.dbPath ? { dbPath: instance.dbPath } : {}),
  });

  return {
    instance,
    config,
    dbPath: instance.dbPath,
    env,
  };
}

/**
 * Opens the instance database, runs a callback, and always closes the handle.
 *
 * @param context - Instance runtime context.
 * @param fn - Callback that receives the open database.
 * @returns Result returned by the callback.
 */
export async function withInstanceDatabase<T>(context: WebInstanceContext, fn: (db: SqlDatabase) => Promise<T>): Promise<T> {
  const database = await createDatabase(context.dbPath);
  try {
    return await fn(database);
  } finally {
    await database.close();
  }
}

/**
 * Builds a lazy embedding client for the instance.
 *
 * Construction is deferred until the first non-empty embed call so flows that
 * never embed (for example a dry-run preview) do not require a credential.
 *
 * @param context - Instance runtime context.
 * @returns Embedding port that resolves credentials on first use.
 */
export function createInstanceEmbedding(context: WebInstanceContext): EmbeddingPort {
  return createLazyEmbeddingClient(() => createEmbeddingClient(resolveEmbeddingApiKey(context.config), resolveEmbeddingModel(context.config)));
}
