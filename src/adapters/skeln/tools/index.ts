import type { ExtensionAPI, ExtensionContext } from "skeln";

import type { AgenrSkelnServices } from "../runtime.js";
import type { AgenrSkelnSessionScope } from "../types.js";
import { registerAgenrSkelnRecallTool } from "./recall.js";
import { registerAgenrSkelnStoreTool } from "./store.js";
import { registerAgenrSkelnUpdateTool } from "./update.js";

/** Registers all model-callable agenr tools for the Skeln adapter. */
export function registerAgenrSkelnTools(
  skeln: ExtensionAPI,
  servicesPromise: Promise<AgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
): void {
  registerAgenrSkelnStoreTool(skeln, servicesPromise, resolveScope);
  registerAgenrSkelnRecallTool(skeln, servicesPromise, resolveScope);
  registerAgenrSkelnUpdateTool(skeln, servicesPromise, resolveScope);
}
