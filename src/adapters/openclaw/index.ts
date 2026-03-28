import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { registerAgenrOpenClawTools } from "./tools.js";
import { coerceAgenrOpenClawPluginConfig, createAgenrOpenClawPluginConfigSchema } from "./config.js";
import { buildAgenrMemoryPromptSection } from "./format/prompt-section.js";
import { handleAgenrBeforePromptBuild } from "./hooks/before-prompt-build.js";
import { buildAgenrMemoryFlushPlan } from "./memory/flush-plan.js";
import { createAgenrMemoryRuntime } from "./memory/runtime.js";
import { createAgenrOpenClawServices } from "./runtime.js";
import { createSessionStartTracker } from "./session/state.js";
import type { AgenrOpenClawMemoryPluginApi } from "./types.js";

export default definePluginEntry({
  id: "agenr",
  name: "agenr",
  description: "agenr memory plugin for OpenClaw",
  kind: "memory",
  configSchema: createAgenrOpenClawPluginConfigSchema(),
  register(api) {
    const memoryApi = api as AgenrOpenClawMemoryPluginApi;
    const tracker = createSessionStartTracker();
    const servicesPromise = createAgenrOpenClawServices(coerceAgenrOpenClawPluginConfig(api.pluginConfig), {
      resolvePath: api.resolvePath,
    });

    api.registerMemoryPromptSection(buildAgenrMemoryPromptSection);
    memoryApi.registerMemoryFlushPlan?.((params) => buildAgenrMemoryFlushPlan(params, api.logger));
    memoryApi.registerMemoryRuntime?.(createAgenrMemoryRuntime(servicesPromise));

    registerAgenrOpenClawTools(api, servicesPromise, api.logger);

    api.on("before_prompt_build", (event, ctx) =>
      handleAgenrBeforePromptBuild(event, ctx, {
        logger: api.logger,
        servicesPromise,
        tracker,
      }),
    );

    api.on("gateway_stop", async () => {
      try {
        const services = await servicesPromise;
        await services.close();
      } catch {
        // Ignore startup failures during shutdown.
      }
    });
  },
});
export { OpenClawTranscriptParser, openClawTranscriptParser } from "./transcript/parser.js";
