import type { ExtensionAPI, ExtensionContext } from "../skeln-types.js";

import type { AgenrSkelnServices } from "../runtime.js";
import type { AgenrSkelnSessionScope } from "../types.js";
import { registerAgenrSkelnFetchTool } from "./fetch.js";
import { registerAgenrSkelnGoalAliasTools } from "./goal.js";
import { registerAgenrSkelnRecallTool } from "./recall.js";
import { registerAgenrSkelnStoreTool } from "./store.js";
import { registerAgenrSkelnUpdateTool } from "./update.js";
import { registerAgenrSkelnWorkTool } from "./work.js";

/**
 * Registers all model-callable agenr tools for the Skeln adapter.
 * When goals=false, skips goal alias tool registration (get_goal/create_goal/update_goal)
 * but keeps agenr_work (session working set) fully functional.
 */
export function registerAgenrSkelnTools(
  skeln: ExtensionAPI,
  servicesPromise: Promise<AgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
  goals: boolean = true,
): void {
  registerAgenrSkelnStoreTool(skeln, servicesPromise, resolveScope);
  registerAgenrSkelnRecallTool(skeln, servicesPromise, resolveScope);
  registerAgenrSkelnFetchTool(skeln, servicesPromise, resolveScope);
  registerAgenrSkelnUpdateTool(skeln, servicesPromise, resolveScope);
  registerAgenrSkelnWorkTool(skeln, servicesPromise, resolveScope);
  if (goals) {
    registerAgenrSkelnGoalAliasTools(skeln, servicesPromise, resolveScope);
  }
}
