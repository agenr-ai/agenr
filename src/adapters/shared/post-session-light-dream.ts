import { maybeRunLightDream, type LightDreamTriggerDeps } from "../../app/dreaming/background-triggers.js";
import { formatErrorMessage } from "./errors.js";

/** Logger surface used by post-session light dream triggers. */
export interface PostSessionLightDreamLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  debug?: (message: string) => void;
}

/**
 * Runs the shared post-session light dream trigger when configured.
 *
 * @param params - Dreaming deps, logger, scope label, and optional session context.
 * @returns Promise that resolves after the trigger is evaluated.
 */
export async function runPostSessionLightDream(params: {
  deps: LightDreamTriggerDeps;
  logger: PostSessionLightDreamLogger;
  scope: string;
  sessionContext?: string;
}): Promise<void> {
  const contextSuffix = params.sessionContext ? ` for ${params.sessionContext}` : "";

  try {
    const result = await maybeRunLightDream({ trigger: "post_session" }, params.deps);
    if (result.status === "ran") {
      params.logger.info(`[agenr] ${params.scope} light dream completed${contextSuffix} run=${result.result.runId}`);
      return;
    }

    if (result.reason === "run_in_progress" || result.reason === "episode_write_in_progress") {
      params.logger.info(`[agenr] ${params.scope} light dream skipped${contextSuffix} reason=${result.reason}`);
      return;
    }

    params.logger.debug?.(`[agenr] ${params.scope} light dream skipped${contextSuffix} reason=${result.reason}`);
  } catch (error) {
    params.logger.warn(`[agenr] ${params.scope} light dream failed${contextSuffix}: ${formatErrorMessage(error)}`);
  }
}
