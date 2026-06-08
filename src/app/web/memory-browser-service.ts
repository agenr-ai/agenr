import { listWebDurables, type WebDurableListQuery, type WebDurableListResult } from "../../adapters/db/web-durable-queries.js";
import {
  listActiveProcedures,
  listRecentEpisodes,
  updateEpisodeMetadata,
  type WebEpisodeListResult,
  type WebEpisodeMetadataPatch,
} from "../../adapters/db/web-read-queries.js";
import { createMemoryRepository } from "../../adapters/db/memory-repository.js";
import type { Procedure } from "../../core/types.js";
import { resolveLocalFilesystemPath } from "../../filesystem-path.js";
import { backupDatabaseFile } from "../dreaming/service.js";
import type { DurableTrace } from "../memory/ports.js";
import { withInstanceDatabase, type WebInstanceContext } from "./instance-context.js";

/**
 * Filter facets used to populate the Memory Explorer filter controls.
 */
export interface MemoryFacets {
  /** Distinct claim-key entity prefixes present in active durables. */
  claimKeyPrefixes: string[];
}

/**
 * Lists durables for the operator browser.
 *
 * @param input - Structured durable filter plus instance runtime context.
 * @returns Paginated durable list result.
 */
export async function listDurables(input: WebDurableListQuery & { context: WebInstanceContext }): Promise<WebDurableListResult> {
  return withInstanceDatabase(input.context, (database) => listWebDurables(database, input));
}

/**
 * Loads the full trace detail for one durable.
 *
 * Reuses the shared trace read model so the detail panel renders content,
 * claim lifecycle, provenance, recall history, dreaming actions, profile
 * inclusion, supersession lineage, and a unified timeline.
 *
 * @param input - Durable id plus instance runtime context.
 * @returns Durable trace, or null when the durable is unknown.
 */
export async function loadDurableDetail(input: { id: string; context: WebInstanceContext }): Promise<DurableTrace | null> {
  return withInstanceDatabase(input.context, async (database) => {
    const repository = createMemoryRepository(database);
    return repository.getDurableTrace(input.id);
  });
}

/**
 * Lists recent episodes for the read-side browser.
 *
 * @param input - Pagination and optional project filter plus instance runtime context.
 * @returns Paginated active episodes.
 */
export async function listEpisodes(input: { project?: string; limit?: number; offset?: number; context: WebInstanceContext }): Promise<WebEpisodeListResult> {
  return withInstanceDatabase(input.context, (database) => listRecentEpisodes(database, input));
}

/**
 * Updates metadata-only fields on an active episode.
 *
 * @param input - Target id, metadata fields, and instance runtime context.
 * @returns True when the episode was found and updated.
 */
export async function updateEpisode(input: {
  id: string;
  fields: WebEpisodeMetadataPatch;
  context: WebInstanceContext;
}): Promise<{ updated: boolean; backupPath: string | null }> {
  const backupPath = await maybeBackup(input.context.dbPath);
  return withInstanceDatabase(input.context, async (database) => {
    const updated = await updateEpisodeMetadata(database, input.id, input.fields);
    return { updated, backupPath };
  });
}

/**
 * Lists active procedures for the read-side browser.
 *
 * @param input - Optional limit plus instance runtime context.
 * @returns Active procedure revisions ordered by key.
 */
export async function listProcedures(input: { limit?: number; context: WebInstanceContext }): Promise<Procedure[]> {
  return withInstanceDatabase(input.context, (database) => listActiveProcedures(database, input.limit));
}

/**
 * Loads filter facets for the Memory Explorer controls.
 *
 * @param input - Instance runtime context.
 * @returns Distinct claim-key prefixes for filter suggestions.
 */
export async function loadMemoryFacets(input: { context: WebInstanceContext }): Promise<MemoryFacets> {
  return withInstanceDatabase(input.context, async (database) => {
    const claimKeyPrefixes = await database.getDistinctClaimKeyPrefixes();
    return { claimKeyPrefixes };
  });
}

/** Creates a database backup when the path is a real local file. */
async function maybeBackup(dbPath: string): Promise<string | null> {
  if (dbPath === ":memory:" || resolveLocalFilesystemPath(dbPath) === null) {
    return null;
  }

  return backupDatabaseFile(dbPath);
}
