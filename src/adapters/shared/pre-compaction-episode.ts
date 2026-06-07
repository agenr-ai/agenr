import { withEpisodeWriteGuard } from "../../app/dreaming/concurrency.js";
import type { DreamPort } from "../../app/dreaming/ports.js";

/**
 * Schedules one guarded episode write without blocking the host lifecycle hook.
 *
 * @param params - Dream guard inputs, write callback, and failure logger.
 */
export function scheduleGuardedEpisodeWrite(params: {
  dreaming: DreamPort;
  dbPath: string;
  write: () => Promise<void>;
  onFailure: (error: unknown) => void;
}): void {
  void withEpisodeWriteGuard({ port: params.dreaming, dbPath: params.dbPath }, params.write).catch(params.onFailure);
}
