import type { AgentTool } from "@mariozechner/pi-agent-core";

import type { RecallPorts } from "../../../core/ports.js";
import type { SurgeonRunAction } from "../../../core/surgeon/domain/action-types.js";
import type { SurgeonPassType } from "../../../core/surgeon/domain/pass-types.js";
import type { SurgeonCompletionSummary } from "../../../core/surgeon/types.js";
import type { BudgetTracker } from "../budget.js";
import type { SurgeonCompletionGuardState } from "../completion-guard.js";
import type { SurgeonPort } from "../ports.js";
import { createCompletePassTool } from "./complete.js";
import { createHealthStatsTool } from "./health.js";
import { createInspectEntryTool } from "./inspect.js";
import { createRetireEntryTool } from "./mutate.js";
import { createQueryCandidatesTool } from "./query.js";
import { createSimulateRecallTool } from "./recall-sim.js";
import { createAssignClaimKeyTool } from "./supersession-claim.js";
import { createLinkSupersessionTool } from "./supersession-link.js";
import { createQuerySupersessionCandidatesTool } from "./supersession-query.js";
import { createSetValidityTool } from "./supersession-validity.js";
import { createUpdateEntryTool } from "./update-entry.js";

/**
 * Mutable completion marker shared across surgeon tools for one run.
 */
export interface SurgeonToolCompletionState {
  isComplete: boolean;
  summary: SurgeonCompletionSummary | null;
  setComplete(summary: SurgeonCompletionSummary): void;
}

/**
 * Shared dependency bag passed to every surgeon tool.
 */
export interface SurgeonToolDeps {
  passType: Extract<SurgeonPassType, "retirement" | "supersession">;
  port: SurgeonPort;
  runId: string;
  project?: string;
  apply: boolean;
  protection: {
    protectRecalledDays: number;
    protectMinImportance: number;
  };
  skipRecentlyEvaluatedDays: number;
  now(): Date;
  recordRunAction(action: SurgeonRunAction): Promise<void>;
  completionState: SurgeonToolCompletionState;
  budgetTracker?: BudgetTracker;
  costCap?: number;
  completionGuards?: SurgeonCompletionGuardState;
  recallPorts?: RecallPorts;
}

/**
 * Creates the retirement-only surgeon tool set for the v1 MVP.
 *
 * @param deps - Shared run dependencies used by every tool.
 * @returns Ordered tool array for pi-agent-core registration.
 */
export function createSurgeonTools(deps: SurgeonToolDeps): AgentTool[] {
  return [
    createHealthStatsTool(deps),
    createQueryCandidatesTool(deps),
    createInspectEntryTool(deps),
    createSimulateRecallTool(deps),
    createRetireEntryTool(deps),
    createUpdateEntryTool(deps),
    createCompletePassTool(deps),
  ] as unknown as AgentTool[];
}

/**
 * Creates the supersession-pass surgeon tool set.
 *
 * @param deps - Shared run dependencies used by every tool.
 * @returns Ordered tool array for the supersession review pass.
 */
export function createSupersessionTools(deps: SurgeonToolDeps): AgentTool[] {
  return [
    createHealthStatsTool(deps),
    createQuerySupersessionCandidatesTool(deps),
    createInspectEntryTool(deps),
    createSimulateRecallTool(deps),
    createLinkSupersessionTool(deps),
    createAssignClaimKeyTool(deps),
    createSetValidityTool(deps),
    createUpdateEntryTool(deps),
    createCompletePassTool(deps),
  ] as unknown as AgentTool[];
}
