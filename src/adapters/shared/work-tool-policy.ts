import type { AgenrWorkAction } from "../../app/working-memory/constants.js";
import type { AgenrWorkParams } from "../../app/working-memory/mutations.js";

/**
 * Model-visible agenr_work actions. Close and trusted mutations use host paths.
 */
const MODEL_VISIBLE_WORK_ACTIONS = ["get", "list", "create", "update"] as const satisfies readonly AgenrWorkAction[];

/** Reserved model-facing agenr_work actions blocked before service execution. */
export type ReservedModelWorkAction = "close" | "set_status";

/**
 * User-facing failure text for reserved model agenr_work actions.
 */
const RESERVED_MODEL_WORK_MESSAGES = {
  close: "agenr_work failed: agenr_work close is reserved for /goal clear and host lifecycle paths.",
  set_status: "agenr_work failed: status changes are reserved for get_goal/create_goal/update_goal and trusted host lifecycle paths.",
} as const;

/**
 * Returns the reserved action when model-facing agenr_work must fail closed.
 *
 * Trusted host callers must route through service or Skeln work-command paths instead
 * of the model tool runner.
 *
 * @param params - Parsed working-memory params from the model tool path.
 * @returns Reserved action discriminator, or null when execution may continue.
 */
export function getModelReservedWorkAction(params: AgenrWorkParams): ReservedModelWorkAction | null {
  if (params.source !== undefined && params.source !== "tool") {
    return null;
  }

  if (params.action === "close") {
    return "close";
  }

  if (params.operation?.type === "set_status") {
    return "set_status";
  }

  return null;
}

/**
 * Returns true when a raw action string is model-visible.
 *
 * @param value - Raw action from tool params.
 */
export function isModelVisibleWorkAction(value: string | undefined): value is (typeof MODEL_VISIBLE_WORK_ACTIONS)[number] {
  return value !== undefined && MODEL_VISIBLE_WORK_ACTIONS.includes(value as (typeof MODEL_VISIBLE_WORK_ACTIONS)[number]);
}

export { MODEL_VISIBLE_WORK_ACTIONS, RESERVED_MODEL_WORK_MESSAGES };
