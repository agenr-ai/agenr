import type { ExtensionContext } from "./skeln-types.js";

import type {
  GoalContinuationCancelCommand,
  GoalContinuationQueryCommand,
  GoalContinuationResult,
  GoalContinuationScheduleCommand,
} from "../../app/goal-continuation/service.js";
import type { WorkingScope } from "../../app/working-memory/scope.js";
import type { createAgenrSkelnServices } from "./runtime.js";
import { toWorkingScopeFromSkelnSession } from "./session/scope.js";
import type { AgenrSkelnSessionScope } from "./types.js";

/**
 * Trusted schedule command accepted by the Skeln controller.
 *
 * Scope is optional here; the adapter merges the resolved session scope under
 * any explicit overrides before delegating to the app service.
 */
export interface AgenrSkelnGoalContinuationScheduleCommandParams extends Omit<GoalContinuationScheduleCommand, "scope"> {
  /** Optional raw scope overrides merged over the resolved session scope. */
  scope?: Partial<WorkingScope>;
}

/** Trusted continuation command params accepted by the Skeln controller. */
export type AgenrSkelnGoalContinuationCommandParams =
  | AgenrSkelnGoalContinuationScheduleCommandParams
  | GoalContinuationCancelCommand
  | GoalContinuationQueryCommand;

/**
 * Executes one trusted goal-continuation command through the Skeln runtime services.
 *
 * @param servicesPromise - Lazily initialized Skeln services.
 * @param resolveScope - Resolves the active session scope for the command.
 * @param context - Active Skeln extension context.
 * @param params - Trusted continuation command params.
 * @returns Goal-continuation result from the app boundary.
 */
export async function executeAgenrSkelnGoalContinuationCommand(
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
  context: ExtensionContext,
  params: AgenrSkelnGoalContinuationCommandParams,
): Promise<GoalContinuationResult> {
  if (params.kind !== "schedule_continuation") {
    const services = await servicesPromise;
    return services.goalContinuation.runCommand(params);
  }

  const [services, sessionScope] = await Promise.all([servicesPromise, resolveScope(context)]);
  return services.goalContinuation.runCommand({
    ...params,
    scope: {
      ...toWorkingScopeFromSkelnSession(sessionScope),
      ...(params.scope ?? {}),
    },
  });
}
