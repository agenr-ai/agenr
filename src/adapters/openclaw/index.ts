import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { registerAgenrOpenClawTools } from "./tools.js";
import { coerceAgenrOpenClawPluginConfig, createAgenrOpenClawPluginConfigSchema, resolveStoreNudgeConfig } from "./config.js";
import { buildAgenrMemoryPromptSection } from "./format/prompt-section.js";
import { handleAgenrAfterToolCall } from "./hooks/after-tool-call.js";
import { handleAgenrBeforePromptBuild } from "./hooks/before-prompt-build.js";
import { handleOpenClawAfterCompaction, handleOpenClawBeforeCompaction } from "./hooks/compaction-handlers.js";
import { handleAgenrSessionEnd } from "./hooks/session-end.js";
import { buildOpenClawSessionBeforeTreeTriggerEvent, buildOpenClawSessionStartTriggerEvent } from "./hooks/session-memory.js";
import { routeOpenClawSessionMemoryTrigger } from "./hooks/session-memory-routing.js";
import { formatErrorMessage } from "./logging.js";
import { buildAgenrMemoryFlushPlan } from "./memory/flush-plan.js";
import { createAgenrMemoryRuntime } from "./memory/runtime.js";
import { createAgenrOpenClawServices } from "./runtime.js";
import { toOpenClawSessionScopeContext } from "./session/scope.js";
import { createSessionLifecycleIntakeTracker } from "../../app/plugin-runtime/session-lifecycle-intake.js";
import { createSessionStartTracker } from "../../app/plugin-runtime/session-tracking.js";
import { createCompactionPromptTracker } from "../shared/compaction-prompt-tracker.js";
import { createMidSessionTracker } from "./session/state.js";

export default definePluginEntry({
  id: "agenr",
  name: "agenr",
  description: "agenr memory plugin for OpenClaw",
  kind: "memory",
  configSchema: createAgenrOpenClawPluginConfigSchema(),
  register(api) {
    const sessionStartTracker = createSessionStartTracker();
    const midSessionTracker = createMidSessionTracker();
    const compactionPromptTracker = createCompactionPromptTracker();
    const lifecycleIntakeTracker = createSessionLifecycleIntakeTracker();
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
        compactionPromptTracker,
        lifecycleIntakeTracker,
      }),
    );
    api.on("session_start", (event, ctx) => {
      const scopeContext = toOpenClawSessionScopeContext({
        sessionId: event.sessionId,
        sessionKey: event.sessionKey,
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      });
      return lifecycleIntakeTracker.track(
        scopeContext.sessionId,
        scopeContext.sessionKey,
        routeOpenClawSessionMemoryTrigger(servicesPromise, scopeContext, (scope) => buildOpenClawSessionStartTriggerEvent(scope, event)),
      );
    });
    api.on("before_compaction", (event, ctx) => {
      const scopeContext = toOpenClawSessionScopeContext(ctx);
      return lifecycleIntakeTracker.track(
        scopeContext.sessionId,
        scopeContext.sessionKey,
        handleOpenClawBeforeCompaction(event, scopeContext, {
          logger: api.logger,
          servicesPromise,
        }),
      );
    });
    api.on("after_compaction", (event, ctx) => {
      const scopeContext = toOpenClawSessionScopeContext(ctx);
      return lifecycleIntakeTracker.track(
        scopeContext.sessionId,
        scopeContext.sessionKey,
        handleOpenClawAfterCompaction(event, scopeContext, {
          logger: api.logger,
          servicesPromise,
        }),
      );
    });
    api.on("before_reset", (event, ctx) => {
      const scopeContext = toOpenClawSessionScopeContext(ctx);
      return lifecycleIntakeTracker.track(
        scopeContext.sessionId,
        scopeContext.sessionKey,
        routeOpenClawSessionMemoryTrigger(servicesPromise, scopeContext, (scope) => buildOpenClawSessionBeforeTreeTriggerEvent(scope, event)),
      );
    });
    api.on("after_tool_call", (event, ctx) => {
      handleAgenrAfterToolCall(event, ctx, {
        logger: api.logger,
        midSessionTracker,
      });
    });
    api.on("session_end", async (event) => {
      compactionPromptTracker.clear(event.sessionId, event.sessionKey);
      await lifecycleIntakeTracker.clear(event.sessionId, event.sessionKey);
      return handleAgenrSessionEnd(event, {
        logger: api.logger,
        servicesPromise,
        midSessionTracker,
      });
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
