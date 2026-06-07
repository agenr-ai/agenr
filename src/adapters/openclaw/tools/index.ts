import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginLogger } from "openclaw/plugin-sdk/core";

import type { AgenrOpenClawServices } from "../types.js";
import { createAgenrFetchTool } from "./fetch.js";
import { createAgenrRecallTool } from "./recall.js";
import { createAgenrStoreTool } from "./store.js";
import { createAgenrUpdateTool } from "./update.js";
import { createAgenrWorkTool } from "./work.js";

export { createAgenrFetchTool, createAgenrRecallTool, createAgenrStoreTool, createAgenrUpdateTool, createAgenrWorkTool };

/**
 * Registers the Phase 1 agenr tools with the OpenClaw plugin API.
 *
 * @param api - OpenClaw plugin registration API.
 * @param servicesPromise - Shared agenr adapters reused for the process lifetime.
 * @param logger - Host logger supplied by the OpenClaw plugin runtime.
 * @returns Nothing.
 */
export function registerAgenrOpenClawTools(api: OpenClawPluginApi, servicesPromise: Promise<AgenrOpenClawServices>, logger: PluginLogger): void {
  api.registerTool((ctx) => createAgenrStoreTool(ctx, servicesPromise, logger), { names: ["agenr_store"] });
  api.registerTool((ctx) => createAgenrRecallTool(ctx, servicesPromise, logger), { names: ["agenr_recall"] });
  api.registerTool((ctx) => createAgenrFetchTool(ctx, servicesPromise, logger), { names: ["agenr_fetch"] });
  api.registerTool((ctx) => createAgenrUpdateTool(ctx, servicesPromise, logger), { names: ["agenr_update"] });
  api.registerTool((ctx) => createAgenrWorkTool(ctx, servicesPromise, logger), { names: ["agenr_work"] });
}
