import type { ExtensionAPI, ExtensionContext } from "../skeln-types.js";

import {
  CREATE_GOAL_TOOL_PARAMETERS,
  GET_GOAL_TOOL_PARAMETERS,
  UPDATE_GOAL_TOOL_PARAMETERS,
  type GoalAliasToolName,
  runGoalAliasTool,
} from "../../shared/goal-tools.js";
import { toWorkingScopeFromSkelnSession } from "../session/scope.js";
import type { AgenrSkelnServices } from "../runtime.js";
import type { AgenrSkelnSessionScope } from "../types.js";
import { SKELN_PARAM_READER, textToolResult, toolFailureResult, toolSchema } from "./shared.js";

/** Registers Codex-compatible goal alias tools backed by Agenr working memory. */
export function registerAgenrSkelnGoalAliasTools(
  skeln: ExtensionAPI,
  servicesPromise: Promise<AgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
): void {
  registerGoalAliasTool(skeln, servicesPromise, resolveScope, {
    name: "get_goal",
    label: "Get Goal",
    description: "Get the current goal for this thread, including status, budgets, usage, and remaining token budget.",
    parameters: GET_GOAL_TOOL_PARAMETERS,
  });
  registerGoalAliasTool(skeln, servicesPromise, resolveScope, {
    name: "create_goal",
    label: "Create Goal",
    description:
      "Create a goal only when explicitly requested by the user or system/developer instructions. Fails if a goal already exists; use update_goal only for status.",
    parameters: CREATE_GOAL_TOOL_PARAMETERS,
  });
  registerGoalAliasTool(skeln, servicesPromise, resolveScope, {
    name: "update_goal",
    label: "Update Goal",
    description:
      "Update the existing goal. Use this tool only to mark the goal achieved or genuinely blocked; pause, resume, and budget states are controlled by the user or system.",
    parameters: UPDATE_GOAL_TOOL_PARAMETERS,
  });
}

/** Registers one goal alias with shared execution. */
function registerGoalAliasTool(
  skeln: ExtensionAPI,
  servicesPromise: Promise<AgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
  definition: {
    name: GoalAliasToolName;
    label: string;
    description: string;
    parameters: object;
  },
): void {
  skeln.registerTool({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    promptSnippet: `${definition.name} is a Codex-compatible alias over Agenr working memory.`,
    parameters: toolSchema(definition.parameters),
    execute: async (_toolCallId, rawParams, _signal, _onUpdate, context) => {
      try {
        const [services, scope] = await Promise.all([servicesPromise, resolveScope(context)]);
        const outcome = await runGoalAliasTool(definition.name, rawParams, toWorkingScopeFromSkelnSession(scope), SKELN_PARAM_READER, services.workingMemory);
        return textToolResult(outcome.text, outcome.details);
      } catch (error) {
        return toolFailureResult(error);
      }
    },
  });
}
