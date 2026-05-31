import type { AgenrWorkParams } from "../../app/working-memory/mutations.js";
import type { WorkingMemoryService } from "../../app/working-memory/service.js";
import type { WorkingMemoryResult } from "../../app/working-memory/results.js";
import { buildWorkingMemoryDetails, formatWorkingMemoryResultText } from "./work-tool-presentations.js";
export { mergeWorkingScope, parseWorkToolParams, WORK_TOOL_PARAMETERS } from "./work-tool-operations.js";
export { getModelReservedWorkAction, MODEL_VISIBLE_WORK_ACTIONS, RESERVED_MODEL_WORK_MESSAGES } from "./work-tool-policy.js";
import { getModelReservedWorkAction, RESERVED_MODEL_WORK_MESSAGES } from "./work-tool-policy.js";

/** Host-neutral work-tool result. */
export interface WorkToolOutcome {
  text: string;
  details: Record<string, unknown>;
  failed: boolean;
}

/**
 * Executes one parsed agenr_work request through the app service.
 *
 * @param params - Parsed working-memory params.
 * @param workingMemory - App working-memory service.
 * @returns Host-neutral tool outcome.
 */
export async function runWorkMemoryTool(params: AgenrWorkParams, workingMemory: WorkingMemoryService): Promise<WorkToolOutcome> {
  const reserved = getModelReservedWorkAction(params);
  if (reserved) {
    return {
      text: RESERVED_MODEL_WORK_MESSAGES[reserved],
      details: {
        status: "failed",
        code: reserved === "close" ? "reserved_close" : "reserved_status",
      },
      failed: true,
    };
  }

  const result = await workingMemory.run(params);
  return workingMemoryResultToToolOutcome(result);
}

/** Maps one app working-memory result to the host-neutral tool envelope. */
export function workingMemoryResultToToolOutcome(result: WorkingMemoryResult): WorkToolOutcome {
  return {
    text: formatWorkingMemoryResultText(result),
    details: buildWorkingMemoryDetails(result),
    failed: !result.ok,
  };
}
