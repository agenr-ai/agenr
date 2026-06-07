import type { WorkingMemoryFailure, WorkingMemoryResult } from "../../app/working-memory/results.js";
import type { WorkingScope } from "../../app/working-memory/scope.js";
import type { WorkingMemoryService } from "../../app/working-memory/service.js";
import { asRecord } from "./durable-tools.js";
import type { MemoryToolParamReader } from "./memory-tools.js";
import { toGoalToolResponse } from "./goal-tool-presentations.js";
import type { WorkToolOutcome } from "./work-tools.js";

/** Codex-compatible get_goal parameters. */
const GET_GOAL_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

/** Codex-compatible create_goal parameters. */
const CREATE_GOAL_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    objective: {
      type: "string",
      description:
        "Required. The concrete objective to start pursuing. This starts a new active goal only when no goal is currently defined; if a goal already exists, this tool fails. Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.",
    },
    token_budget: {
      type: "integer",
      minimum: 1,
      description: "Positive token budget for the new goal. Omit unless explicitly requested.",
    },
  },
  required: ["objective"],
} as const;

/** Codex-compatible update_goal parameters. */
const UPDATE_GOAL_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["complete", "blocked"],
      description:
        "Required. Set to complete only when the objective is achieved and no required work remains. Set to blocked only when the goal cannot currently proceed until something external changes. Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work. When marking a budgeted goal achieved with status complete, report the final token usage from the tool result to the user.",
    },
  },
  required: ["status"],
} as const;

/** Status values accepted by Codex-compatible update_goal. */
const GOAL_ALIAS_UPDATE_STATUSES = ["complete", "blocked"] as const;

/** Names of the Codex-compatible goal alias tools. */
export type GoalAliasToolName = "get_goal" | "create_goal" | "update_goal";

const CREATE_GOAL_EXISTS_MESSAGE = "cannot create a new goal because this thread already has a goal; use update_goal only when the existing goal is complete";
const UPDATE_GOAL_UNSUPPORTED_STATUS_MESSAGE =
  "update_goal can only mark the existing goal complete or blocked; pause, resume, budget-limited, and usage-limited status changes are controlled by the user or system";

/**
 * Runs a Codex-compatible goal alias over the Agenr working-memory service.
 *
 * @param toolName - Alias tool name.
 * @param rawParams - Raw model-supplied parameters.
 * @param defaultScope - Host-derived scope facts.
 * @param reader - Host parameter reader.
 * @param workingMemory - Working-memory service.
 * @returns Host-neutral tool outcome.
 */
export async function runGoalAliasTool(
  toolName: GoalAliasToolName,
  rawParams: unknown,
  defaultScope: Partial<WorkingScope>,
  reader: MemoryToolParamReader,
  workingMemory: WorkingMemoryService,
): Promise<WorkToolOutcome> {
  switch (toolName) {
    case "get_goal":
      return runGetGoalTool(defaultScope, workingMemory);
    case "create_goal":
      return runCreateGoalTool(rawParams, defaultScope, reader, workingMemory);
    case "update_goal":
      return runUpdateGoalTool(rawParams, defaultScope, reader, workingMemory);
  }
}

/** Runs get_goal. */
async function runGetGoalTool(defaultScope: Partial<WorkingScope>, workingMemory: WorkingMemoryService): Promise<WorkToolOutcome> {
  const result = await workingMemory.run({ action: "get", target: "goal", scope: defaultScope });
  if (!result.ok && result.code === "missing_active_set") {
    return goalSuccess(null, false);
  }

  return resultToGoalOutcome(result, false);
}

/** Runs create_goal. */
async function runCreateGoalTool(
  rawParams: unknown,
  defaultScope: Partial<WorkingScope>,
  reader: MemoryToolParamReader,
  workingMemory: WorkingMemoryService,
): Promise<WorkToolOutcome> {
  const params = asRecord(rawParams);
  const objective = reader.readString(params, "objective", { required: true }) ?? "";
  const tokenBudget = reader.readNumber(params, "token_budget", { integer: true, strict: true });
  if (tokenBudget !== undefined && tokenBudget <= 0) {
    return goalFailure("invalid_request", "token_budget must be positive.");
  }

  const result = await workingMemory.run({
    action: "create",
    target: "goal",
    scope: defaultScope,
    operation: {
      type: "set_objective",
      objective,
    },
    initialSnapshot: await workingMemory.readSessionSnapshotForFork(defaultScope),
    ...(tokenBudget !== undefined ? { initialBudget: { tokenBudget } } : {}),
    updateReason: "Model created goal via create_goal.",
    actor: "model",
    source: "goal_command",
  });

  if (!result.ok && result.code === "active_set_exists") {
    return goalFailure(result.code, CREATE_GOAL_EXISTS_MESSAGE, result.details);
  }

  return resultToGoalOutcome(result, false);
}

/** Runs update_goal. */
async function runUpdateGoalTool(
  rawParams: unknown,
  defaultScope: Partial<WorkingScope>,
  reader: MemoryToolParamReader,
  workingMemory: WorkingMemoryService,
): Promise<WorkToolOutcome> {
  const params = asRecord(rawParams);
  const status = reader.readString(params, "status", { required: true });
  if (!isGoalAliasUpdateStatus(status)) {
    return goalFailure("invalid_request", UPDATE_GOAL_UNSUPPORTED_STATUS_MESSAGE);
  }

  const update = await workingMemory.run({
    action: "update",
    target: "goal",
    scope: defaultScope,
    operation: {
      type: "set_status",
      status,
    },
    updateReason: status === "complete" ? "Model marked goal complete via update_goal." : "Model marked goal blocked via update_goal.",
    actor: "model",
    source: "goal_command",
  });

  return resultToGoalOutcome(update, status === "complete");
}

/** Returns true when update_goal supplied a supported terminal status. */
function isGoalAliasUpdateStatus(status: string | undefined): status is GoalAliasUpdateStatus {
  return status === "complete" || status === "blocked";
}

/** Maps one working-memory result into a goal alias outcome. */
function resultToGoalOutcome(result: WorkingMemoryResult, includeCompletionReport: boolean): WorkToolOutcome {
  if (!result.ok) {
    return goalFailure(result.code, result.message, result.details);
  }

  switch (result.action) {
    case "get":
    case "create":
    case "update":
      return goalSuccess(result.workingSet, includeCompletionReport);
    case "list":
    case "close":
    case "prepare_external_goal_mutation":
      return goalFailure("invalid_request", `Goal alias cannot return agenr_work ${result.action} results.`);
  }
}

/** Builds a successful JSON goal response. */
function goalSuccess(workingSet: Parameters<typeof toGoalToolResponse>[0], includeCompletionReport: boolean): WorkToolOutcome {
  const response = toGoalToolResponse(workingSet, includeCompletionReport);
  return {
    text: JSON.stringify(response, null, 2),
    details: {
      goal: response.goal,
      remainingTokens: response.remainingTokens,
      completionBudgetReport: response.completionBudgetReport,
    },
    failed: false,
  };
}

/** Builds a failed goal response. */
function goalFailure(code: WorkingMemoryFailure["code"], message: string, details?: Record<string, unknown>): WorkToolOutcome {
  return {
    text: message,
    details: {
      status: "failed",
      code,
      ...(details ? { details } : {}),
    },
    failed: true,
  };
}

export type { GoalToolGoal, GoalToolResponse } from "./goal-tool-presentations.js";
export { CREATE_GOAL_TOOL_PARAMETERS, GET_GOAL_TOOL_PARAMETERS, GOAL_ALIAS_UPDATE_STATUSES, UPDATE_GOAL_TOOL_PARAMETERS };

/** Alias exported for tests and callers that referenced the old local type name. */
export type GoalAliasUpdateStatus = (typeof GOAL_ALIAS_UPDATE_STATUSES)[number];
