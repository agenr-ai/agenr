import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { registerAgenrOpenClawTools } from "./tools.js";
import { coerceAgenrOpenClawPluginConfig, createAgenrOpenClawPluginConfigSchema, resolveStoreNudgeConfig } from "./config.js";
import { buildAgenrMemoryPromptSection } from "./format/prompt-section.js";
import { handleAgenrAfterToolCall } from "./hooks/after-tool-call.js";
import { handleAgenrBeforePromptBuild } from "./hooks/before-prompt-build.js";
import { formatErrorMessage } from "./logging.js";
import { buildAgenrMemoryFlushPlan } from "./memory/flush-plan.js";
import { createAgenrMemoryRuntime } from "./memory/runtime.js";
import { createAgenrOpenClawServices } from "./runtime.js";
import { createMidSessionTracker, createSessionStartTracker } from "./session/state.js";

export default definePluginEntry({
  id: "agenr",
  name: "agenr",
  description: "agenr memory plugin for OpenClaw",
  kind: "memory",
  configSchema: createAgenrOpenClawPluginConfigSchema(),
  register(api) {
    const sessionStartTracker = createSessionStartTracker();
    const midSessionTracker = createMidSessionTracker();
    const pluginConfig = coerceAgenrOpenClawPluginConfig(api.pluginConfig);
    const storeNudgeConfig = resolveStoreNudgeConfig(pluginConfig.storeNudge);
    const servicesPromise = createAgenrOpenClawServices(pluginConfig, {
      openClaw: {
        config: api.config,
        runtime: {
          agent: api.runtime.agent,
          state: api.runtime.state,
          modelAuth: api.runtime.modelAuth,
        },
      },
      resolvePath: api.resolvePath,
    });
    void servicesPromise.catch((error) => {
      api.logger.error(`[agenr] startup failed: ${formatErrorMessage(error)}`);
    });

    api.registerMemoryCapability({
      promptBuilder: buildAgenrMemoryPromptSection,
      flushPlanResolver: (params) => buildAgenrMemoryFlushPlan(params, api.logger),
      runtime: createAgenrMemoryRuntime(servicesPromise),
    });

    registerAgenrOpenClawTools(api, servicesPromise, api.logger);

    api.on("before_prompt_build", (event, ctx) =>
      handleAgenrBeforePromptBuild(event, ctx, {
        logger: api.logger,
        servicesPromise,
        tracker: sessionStartTracker,
        midSessionTracker,
        storeNudgeConfig,
      }),
    );
    api.on("session_start", (event) => {
      sessionStartTracker.rememberSessionStart(event.sessionId, event.sessionKey, event.resumedFrom);
    });
    api.on("after_tool_call", (event, ctx) => {
      handleAgenrAfterToolCall(event, ctx, {
        logger: api.logger,
        midSessionTracker,
      });
    });
    api.on("session_end", (event) => {
      midSessionTracker.clear(event.sessionId, event.sessionKey);
    });

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
