import type { GoalContinuationFeatureFlags } from "../features/types.js";

/**
 * Stable failure codes returned by the goal-continuation boundary.
 */
export type GoalContinuationErrorCode = "feature_disabled" | "host_callback_missing";

/** Failed goal-continuation service result. */
export interface GoalContinuationFailure {
  /** Failure discriminator. */
  ok: false;
  /** Stable failure code. */
  code: GoalContinuationErrorCode;
  /** Human-readable failure message. */
  message: string;
}

/**
 * Successful host-owned goal-continuation result.
 */
export interface GoalContinuationSuccess {
  /** Success discriminator. */
  ok: true;
  /** Optional host-authored result message. */
  message?: string;
}

/** Result returned by the goal-continuation boundary. */
export type GoalContinuationResult = GoalContinuationSuccess | GoalContinuationFailure;

/** Host callback port for future Skeln-owned goal continuation. */
export interface GoalContinuationHostPort {
  /**
   * Handles a goal-continuation command in the host runtime.
   *
   * @param params - Command payload from the caller.
   * @returns Host-owned continuation result.
   */
  runCommand(params: { command: string }): Promise<GoalContinuationResult>;
}

/**
 * Goal-continuation service surface.
 */
export interface GoalContinuationService {
  /**
   * Routes future `/goal` or host-equivalent continuation commands to the host.
   *
   * @param params - Host command payload reserved for later phases.
   * @returns A fail-closed result unless a host callback is registered.
   */
  runCommand(params: { command: string }): Promise<GoalContinuationResult>;
}

const GOAL_CONTINUATION_FEATURE_DISABLED_MESSAGE = "Goal continuation is disabled by the goalContinuation feature flag.";

const GOAL_CONTINUATION_HOST_MISSING_MESSAGE = "Goal continuation is host-owned; no host callback was registered for this Agenr runtime.";

/**
 * Creates the goal-continuation service that delegates `/goal` continuation to the host.
 *
 * The service fails closed until both the goalContinuation feature flag is enabled
 * and a host callback is registered.
 *
 * @param featureFlags - Resolved runtime feature flags.
 * @param hostPort - Optional host-owned continuation callback.
 * @returns A goal-continuation service bound to the host contract.
 */
export function createGoalContinuationService(featureFlags: GoalContinuationFeatureFlags, hostPort?: GoalContinuationHostPort): GoalContinuationService {
  const featureEnabled = featureFlags.goalContinuation;

  return {
    async runCommand(params) {
      if (!featureEnabled) {
        return {
          ok: false,
          code: "feature_disabled",
          message: GOAL_CONTINUATION_FEATURE_DISABLED_MESSAGE,
        };
      }

      if (!hostPort) {
        return {
          ok: false,
          code: "host_callback_missing",
          message: GOAL_CONTINUATION_HOST_MISSING_MESSAGE,
        };
      }

      return hostPort.runCommand(params);
    },
  };
}
