import type { DreamEvidenceRef, DreamScanSummary } from "../../core/dreaming/types.js";
import type { DreamPort } from "./ports.js";

/**
 * Options accepted by the deterministic scan stage.
 */
export interface DreamScanOptions {
  project?: string;
  fullBacklog?: boolean;
  now(): Date;
}

/**
 * Dependencies required by the scan stage.
 */
export interface DreamScanDeps {
  port: DreamPort;
}

/**
 * Collects evidence and state deltas since the last successful dreaming run.
 *
 * @param options - Scan options including project scope and clock.
 * @param deps - Persistence port used to read cursors and evidence.
 * @returns Scan summary with evidence locators and counters.
 */
export async function runDreamScan(options: DreamScanOptions, deps: DreamScanDeps): Promise<DreamScanSummary> {
  const since = await resolveScanSince(options, deps.port);

  const [episodesSinceLastRun, episodesPendingSynthesis, ingestFilesSinceLastRun, durablesCreatedSinceLastRun, unsynthesizedImportanceSum] = await Promise.all([
    deps.port.countEpisodesSince(since, options.project),
    deps.port.countUnsynthesizedEpisodes(options.project),
    deps.port.countIngestFilesSince(since),
    deps.port.countDurablesCreatedSince(since, options.project),
    deps.port.sumDurableImportanceCreatedSince(since, options.project),
  ]);

  const evidenceRefs: DreamEvidenceRef[] = [];
  if (ingestFilesSinceLastRun > 0) {
    evidenceRefs.push({
      kind: "ingest_log",
      locator: `since:${since}`,
      observedAt: options.now().toISOString(),
    });
  }
  if (episodesPendingSynthesis > 0) {
    evidenceRefs.push({
      kind: "episode",
      locator: `pending_synthesis:${episodesPendingSynthesis}`,
      observedAt: options.now().toISOString(),
    });
  }

  return {
    episodesSinceLastRun,
    episodesPendingSynthesis,
    ingestFilesSinceLastRun,
    durablesCreatedSinceLastRun,
    evidenceRefs,
    unsynthesizedImportanceSum,
  };
}

/**
 * Resolves the scan cursor for one run.
 *
 * The cursor must come from the last *completed* run. The in-flight run's own
 * row already exists with status `running` when scan executes, so reading the
 * unfiltered latest run would always reset the cursor to the epoch.
 *
 * @param options - Scan options that may request a full-backlog pass.
 * @param port - Dreaming persistence port used to read the latest completed run.
 * @returns ISO lower-bound timestamp for evidence reads.
 */
async function resolveScanSince(options: Pick<DreamScanOptions, "fullBacklog">, port: DreamPort): Promise<string> {
  if (options.fullBacklog === true) {
    return "1970-01-01T00:00:00.000Z";
  }

  const lastCompletedRun = await port.getLastCompletedRun();
  return lastCompletedRun?.completedAt ?? "1970-01-01T00:00:00.000Z";
}
