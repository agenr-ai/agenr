/** Default episode summary generation budget for host shutdown and predecessor writes. */
const EPISODE_SUMMARY_TIMEOUT_MS = 45_000;

/** Stable timeout message persisted on failed episode-ingest rows. */
const EPISODE_SUMMARY_TIMEOUT_MESSAGE = "Episode summary generation timed out.";

export { EPISODE_SUMMARY_TIMEOUT_MESSAGE, EPISODE_SUMMARY_TIMEOUT_MS };

/**
 * Error raised when episode summary generation exceeds its host budget.
 */
export class EpisodeSummaryTimeoutError extends Error {
  /**
   * Creates a timeout error with a stable name for caller-side handling.
   */
  public constructor() {
    super(EPISODE_SUMMARY_TIMEOUT_MESSAGE);
    this.name = "EpisodeSummaryTimeoutError";
  }
}

/**
 * Races one episode summary task against a fixed timeout budget.
 *
 * @param task - In-flight summary generation work.
 * @param timeoutMs - Maximum allowed duration.
 * @returns Task result when it finishes inside the budget.
 */
export async function raceEpisodeSummaryWithinTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new EpisodeSummaryTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
