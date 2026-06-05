import path from "node:path";

import type { SqlExecutor } from "./queries.js";

/**
 * Support queries used only by the episode-ingest CLI orchestration.
 */
export interface EpisodeIngestSupportPort {
  /**
   * Counts persisted entries in the current database.
   *
   * @returns Total row count from `entries`.
   */
  countEntries(): Promise<number>;

  /**
   * Returns whether sampled transcript paths overlap existing ingest provenance.
   *
   * @param sampleFiles - Sample of transcript files to compare against persisted provenance.
   * @returns `true` when existing rows indicate the target path is relevant.
   */
  hasRelevantProvenanceMatch(sampleFiles: string[]): Promise<boolean>;
}

/**
 * Creates the DB-backed support port used by the episode-ingest CLI.
 *
 * @param executor - SQL executor used for support queries.
 * @returns Support port scoped to the episode-ingest CLI workflow.
 */
export function createEpisodeIngestSupportPort(executor: SqlExecutor): EpisodeIngestSupportPort {
  return {
    countEntries: async () => countRows(executor, "SELECT COUNT(*) AS count FROM durables"),
    hasRelevantProvenanceMatch: async (sampleFiles) => hasRelevantProvenanceMatch(executor, sampleFiles),
  };
}

/**
 * Returns whether sampled transcript paths overlap known entry-ingest provenance.
 *
 * @param executor - SQL executor used for the lookup.
 * @param sampleFiles - Sample transcript files from the target path.
 * @returns `true` when existing ingest provenance overlaps the sample.
 */
async function hasRelevantProvenanceMatch(executor: SqlExecutor, sampleFiles: string[]): Promise<boolean> {
  if (sampleFiles.length === 0) {
    return false;
  }

  const exactPlaceholders = sampleFiles.map(() => "?").join(", ");
  const ingestLogMatches = await countRows(executor, `SELECT COUNT(*) AS count FROM ingest_log WHERE file_path IN (${exactPlaceholders})`, sampleFiles);
  if (ingestLogMatches > 0) {
    return true;
  }

  const basenames = Array.from(new Set(sampleFiles.map((filePath) => path.basename(filePath))));
  const basenameClauses = basenames.map(() => "(source_file = ? OR source_file LIKE ?)").join(" OR ");
  const basenameArgs = basenames.flatMap((basename) => [basename, `%/${basename}`]);
  const entryMatches = await countRows(executor, `SELECT COUNT(*) AS count FROM durables WHERE source_file IS NOT NULL AND (${basenameClauses})`, basenameArgs);

  return entryMatches > 0;
}

/**
 * Executes a count query and normalizes the first-row result into a number.
 *
 * @param executor - SQL executor used for the lookup.
 * @param sql - SQL count query to execute.
 * @param args - Optional bound arguments.
 * @returns Normalized count result.
 */
async function countRows(executor: SqlExecutor, sql: string, args: Array<string | number> = []): Promise<number> {
  const result = await executor.execute({
    sql,
    args,
  });
  const row = result.rows[0];
  if (!row) {
    return 0;
  }

  const value = row["count"];
  if (typeof value === "number") {
    return value;
  }

  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
}
