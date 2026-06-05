/**
 * Shared abort signaling for the dreaming pipeline stages.
 *
 * The error message is load-bearing: `runDream` maps it to the `aborted` run
 * status, so every stage must throw the exact same string. Keeping the
 * constants and guard in one module prevents the copies from drifting apart.
 */

/** Canonical error thrown when a dreaming run is cancelled via its abort signal. */
const USER_ABORT_ERROR = "Run aborted by user (SIGINT).";

/** Canonical run summary recorded when a dreaming run is aborted by the user. */
const USER_ABORT_SUMMARY = "Run aborted by user.";

export { USER_ABORT_ERROR, USER_ABORT_SUMMARY };

/**
 * Throws the canonical abort error when the provided signal is aborted.
 *
 * @param signal - Optional abort signal observed by a dreaming stage.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error(USER_ABORT_ERROR);
  }
}
