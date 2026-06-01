import type { ExtensionAPI, ExtensionContext } from "skeln";

import type { AgenrSkelnServices } from "../runtime.js";
import type { AgenrSkelnSessionScope } from "../types.js";
import { registerAgenrSkelnFetchTool } from "./fetch.js";
import { registerAgenrSkelnGoalAliasTools } from "./goal.js";
import { registerAgenrSkelnRecallTool } from "./recall.js";
import { registerAgenrSkelnStoreTool } from "./store.js";
import { registerAgenrSkelnUpdateTool } from "./update.js";
import { registerAgenrSkelnWorkTool } from "./work.js";

/** Registers all model-callable agenr tools for the Skeln adapter. */
export function registerAgenrSkelnTools(
  skeln: ExtensionAPI,
  servicesPromise: Promise<AgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
): void {
  registerAgenrSkelnStoreTool(skeln, servicesPromise, resolveScope);
  registerAgenrSkelnRecallTool(skeln, servicesPromise, resolveScope);
  registerAgenrSkelnFetchTool(skeln, servicesPromise, resolveScope);
  registerAgenrSkelnUpdateTool(skeln, servicesPromise, resolveScope);
  registerAgenrSkelnWorkTool(skeln, servicesPromise, resolveScope);
  registerAgenrSkelnGoalAliasTools(skeln, servicesPromise, resolveScope);
}
