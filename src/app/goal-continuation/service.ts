import type { GoalContinuationFeatureFlags } from "../features/types.js";
import { isGoalScopeKind } from "../working-memory/constants.js";
import type { WorkingSetRecord } from "../working-memory/records.js";
import type { WorkingScope } from "../working-memory/scope.js";

/**
 * Reasons Agenr asks the host to schedule one continuation turn.
 */
const GOAL_CONTINUATION_SCHEDULE_REASONS = ["policy_on_idle", "manual_request"] as const;

/**
 * Union of reasons carried by schedule commands.
 */
export type GoalContinuationScheduleReason = (typeof GOAL_CONTINUATION_SCHEDULE_REASONS)[number];

/**
 * Reasons Agenr asks the host to cancel pending continuation work.
 */
const GOAL_CONTINUATION_CANCEL_REASONS = ["goal_closed", "budget_limited", "policy_changed", "stale"] as const;

/**
 * Union of reasons carried by cancel commands.
 */
export type GoalContinuationCancelReason = (typeof GOAL_CONTINUATION_CANCEL_REASONS)[number];

export { GOAL_CONTINUATION_CANCEL_REASONS, GOAL_CONTINUATION_SCHEDULE_REASONS };

/**
 * Asks the host to schedule one continuation turn for an eligible goal working set.
 */
export interface GoalContinuationScheduleCommand {
  /** Command discriminator. */
  kind: "schedule_continuation";
  /** Goal working set the host should continue. */
  workingSetId: string;
  /** Raw host scope facts the continuation turn should run under. */
  scope: WorkingScope;
  /** ISO timestamp before which the host must not resume. */
  resumeAfter?: string;
  /** Why Agenr is requesting the continuation turn. */
  reason: GoalContinuationScheduleReason;
}

/**
 * Asks the host to cancel pending continuation work for one goal working set.
 */
export interface GoalContinuationCancelCommand {
  /** Command discriminator. */
  kind: "cancel_continuation";
  /** Goal working set whose continuation should be cancelled. */
  workingSetId: string;
  /** Why Agenr is cancelling continuation. */
  reason: GoalContinuationCancelReason;
}

/**
 * Asks the host for the current continuation status of one goal working set.
 */
export interface GoalContinuationQueryCommand {
  /** Command discriminator. */
  kind: "query_continuation";
  /** Goal working set to query. */
  workingSetId: string;
}

/**
 * Typed continuation command routed from Agenr to the host runtime.
 */
export type GoalContinuationCommand = GoalContinuationScheduleCommand | GoalContinuationCancelCommand | GoalContinuationQueryCommand;

/**
 * Failure codes a registered host port may return.
 */
export type GoalContinuationHostErrorCode = "host_rejected" | "host_unavailable";

/**
 * Stable failure codes returned by the goal-continuation boundary.
 */
export type GoalContinuationErrorCode = "feature_disabled" | "host_callback_missing" | "not_eligible" | GoalContinuationHostErrorCode;

/**
 * Successful host-owned goal-continuation result.
 */
export interface GoalContinuationSuccess {
  /** Success discriminator. */
  ok: true;
  /** Whether the host scheduled or has pending continuation work. */
  scheduled?: boolean;
  /** Optional host-authored result message. */
  message?: string;
}

/** Failed goal-continuation service result. */
export interface GoalContinuationFailure {
  /** Failure discriminator. */
  ok: false;
  /** Stable failure code. */
  code: GoalContinuationErrorCode;
  /** Human-readable failure message. */
  message: string;
}

/** Failure shape a registered host port may return. */
export interface GoalContinuationHostFailure {
  /** Failure discriminator. */
  ok: false;
  /** Host-level failure code. */
  code: GoalContinuationHostErrorCode;
  /** Human-readable failure message. */
  message: string;
}

/** Result returned by the goal-continuation boundary. */
export type GoalContinuationResult = GoalContinuationSuccess | GoalContinuationFailure;

/** Result a registered host port returns to Agenr. */
export type GoalContinuationHostResult = GoalContinuationSuccess | GoalContinuationHostFailure;

/** Host callback port for host-owned goal continuation. */
export interface GoalContinuationHostPort {
  /**
   * Handles one typed continuation command in the host runtime.
   *
   * @param command - Continuation command emitted by Agenr.
   * @returns Host-owned continuation result.
   */
  runCommand(command: GoalContinuationCommand): Promise<GoalContinuationHostResult>;
}

/**
 * Goal-continuation service surface.
 */
export interface GoalContinuationService {
  /**
   * Routes one typed continuation command to the host after Agenr-side gating.
   *
   * Schedule commands are checked against the persisted goal working-set state
   * before delegation; cancel and query commands delegate directly.
   *
   * @param command - Continuation command from a trusted host surface.
   * @returns A fail-closed result unless the feature, host port, and eligibility all pass.
   */
  runCommand(command: GoalContinuationCommand): Promise<GoalContinuationResult>;
}

/** Dependencies accepted by the goal-continuation service. */
export interface GoalContinuationServiceDeps {
  /** Optional host-owned continuation callback. */
  hostPort?: GoalContinuationHostPort;
  /** Loads working sets for schedule eligibility checks. */
  readWorkingSet?: (workingSetId: string) => Promise<WorkingSetRecord | null>;
  /** Timestamp provider, mainly for deterministic tests. */
  now?: () => Date;
}

const GOAL_CONTINUATION_FEATURE_DISABLED_MESSAGE = "Goal continuation is disabled by the goalContinuation feature flag.";

const GOAL_CONTINUATION_HOST_MISSING_MESSAGE = "Goal continuation is host-owned; no host callback was registered for this Agenr runtime.";

/**
 * Creates the goal-continuation service that delegates continuation commands to the host.
 *
 * The service fails closed until the goalContinuation feature flag is enabled,
 * a host callback is registered, and schedule commands pass eligibility checks.
 *
 * @param featureFlags - Resolved runtime feature flags.
 * @param deps - Optional host port, working-set reader, and clock.
 * @returns A goal-continuation service bound to the host contract.
 */
export function createGoalContinuationService(featureFlags: GoalContinuationFeatureFlags, deps: GoalContinuationServiceDeps = {}): GoalContinuationService {
  const featureEnabled = featureFlags.goalContinuation;
  const now = () => (deps.now ? deps.now() : new Date());

  return {
    async runCommand(command) {
      if (!featureEnabled) {
        return {
          ok: false,
          code: "feature_disabled",
          message: GOAL_CONTINUATION_FEATURE_DISABLED_MESSAGE,
        };
      }

      const hostPort = deps.hostPort;
      if (!hostPort) {
        return {
          ok: false,
          code: "host_callback_missing",
          message: GOAL_CONTINUATION_HOST_MISSING_MESSAGE,
        };
      }

      if (command.kind === "schedule_continuation") {
        const ineligible = await evaluateScheduleEligibility(command, deps.readWorkingSet, now());
        if (ineligible) {
          return ineligible;
        }
      }

      try {
        return await hostPort.runCommand(command);
      } catch (error) {
        return {
          ok: false,
          code: "host_unavailable",
          message: `Goal-continuation host callback threw: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/**
 * Checks one schedule command against the persisted goal working-set state.
 *
 * @param command - Schedule command about to be delegated to the host.
 * @param readWorkingSet - Optional working-set reader wired by the runtime.
 * @param now - Current time used for resume and staleness checks.
 * @returns A not-eligible failure, or undefined when scheduling may proceed.
 */
async function evaluateScheduleEligibility(
  command: GoalContinuationScheduleCommand,
  readWorkingSet: GoalContinuationServiceDeps["readWorkingSet"],
  now: Date,
): Promise<GoalContinuationFailure | undefined> {
  if (!readWorkingSet) {
    return notEligible(command.workingSetId, "no working-set reader is wired for eligibility checks");
  }

  const workingSet = await readWorkingSet(command.workingSetId);
  if (!workingSet) {
    return notEligible(command.workingSetId, "the working set does not exist");
  }

  if (!isGoalScopeKind(workingSet.scopeKind)) {
    return notEligible(command.workingSetId, "the working set is session-scoped, not a goal");
  }

  if (workingSet.status !== "active") {
    return notEligible(command.workingSetId, `the goal status is ${workingSet.status}, not active`);
  }

  const continuation = workingSet.snapshot.continuation;
  if (continuation?.policy !== "on_idle") {
    return notEligible(command.workingSetId, `the continuation policy is ${continuation?.policy ?? "unset"}, not on_idle`);
  }

  if (workingSet.snapshot.budgets?.limitReason !== undefined) {
    return notEligible(command.workingSetId, `the ${workingSet.snapshot.budgets.limitReason} budget is exhausted`);
  }

  const resumeAfter = parseIsoTimestamp(continuation.resumeAfter);
  if (resumeAfter !== undefined && resumeAfter > now.getTime()) {
    return notEligible(command.workingSetId, `resumeAfter ${continuation.resumeAfter} has not elapsed`);
  }

  const staleAfter = parseIsoTimestamp(continuation.staleAfter);
  if (staleAfter !== undefined && staleAfter <= now.getTime()) {
    return notEligible(command.workingSetId, `the goal context became stale at ${continuation.staleAfter}`);
  }

  return undefined;
}

/** Builds one stable not-eligible failure. */
function notEligible(workingSetId: string, reason: string): GoalContinuationFailure {
  return {
    ok: false,
    code: "not_eligible",
    message: `Goal continuation cannot be scheduled for working set ${workingSetId}: ${reason}.`,
  };
}

/** Parses one optional ISO timestamp; unparseable values are treated as absent. */
function parseIsoTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}
