import type { ExtensionAPI, ExtensionContext } from "skeln";

import type { SessionMemoryTriggerEvent } from "../../app/session-memory/types.js";
import { formatErrorMessage } from "../shared/errors.js";
import { createSessionStartTracker } from "../../app/plugin-runtime/session-tracking.js";
import { mergeSkelnMemoryPolicy, readSkelnMemoryPolicySetting } from "./config.js";
import { handleAgenrSkelnBeforeAgentStart } from "./hooks/before-agent-start.js";
import {
  buildSkelnSessionBeforeCompactTriggerEvent,
  buildSkelnSessionBeforeForkTriggerEvent,
  buildSkelnSessionBeforeTreeTriggerEvent,
  buildSkelnSessionCompactTriggerEvent,
  buildSkelnSessionShutdownTriggerEvent,
  buildSkelnSessionStartTriggerEvent,
  buildSkelnSessionTreeTriggerEvent,
  logSessionMemoryTriggerResult,
  type SkelnSessionBeforeForkEvent,
  type SkelnSessionBeforeTreeEvent,
  type SkelnSessionCompactEvent,
  type SkelnSessionShutdownEvent,
  type SkelnSessionStartTransition,
  type SkelnSessionTreeEvent,
} from "./hooks/session-memory.js";
import { recordSkelnSubagentFindings } from "./hooks/subagent-findings.js";
import { scheduleSkelnSessionShutdownEpisodeWrite } from "./episode/shutdown-episode-write.js";
import { createAgenrSkelnServices } from "./runtime.js";
import type { AgenrSkelnConfig } from "./runtime.js";
import { buildSkelnHostContext, mergeSkelnHostContext, toSkelnSessionScope } from "./session/scope.js";
import { createSkelnSessionScopeTracker, type SkelnSessionScopeTracker } from "./session/state.js";
import { registerAgenrSkelnTools } from "./tools/index.js";
import type { AgenrSkelnSessionScope, RegisterAgenrSkelnMemoryOptions } from "./types.js";
import { executeAgenrSkelnWorkCommand, type AgenrSkelnMemoryController } from "./work-command.js";

export type { AgenrSkelnConfig, AgenrSkelnServices } from "./runtime.js";
export type { AgenrSkelnSessionScope, RegisterAgenrSkelnMemoryOptions, SkelnHostContext } from "./types.js";
export type {
  AgenrSkelnMemoryController,
  AgenrSkelnWorkCommandMutationMetadata,
  AgenrSkelnWorkCommandOutcome,
  AgenrSkelnWorkCommandParams,
  AgenrSkelnWorkCommandSource,
  AgenrSkelnWorkCloseCommandParams,
  AgenrSkelnWorkCreateCommandParams,
  AgenrSkelnWorkGetCommandParams,
  AgenrSkelnWorkListCommandParams,
  AgenrSkelnWorkPrepareExternalGoalMutationCommandParams,
  AgenrSkelnWorkUpdateCommandParams,
} from "./work-command.js";
export { createAgenrSkelnServices } from "./runtime.js";
export { handleAgenrSkelnBeforeAgentStart } from "./hooks/before-agent-start.js";

/**
 * Subset of Skeln lifecycle hook registration used by the agenr adapter.
 */
type SkelnLifecycleHookRegistrar = {
  on(event: "session_start", handler: (event: SkelnSessionStartTransition, context: ExtensionContext) => Promise<void> | void): void;
  on(event: "session_before_fork", handler: (event: SkelnSessionBeforeForkEvent, context: ExtensionContext) => Promise<void> | void): void;
  on(event: "session_before_compact", handler: (event: unknown, context: ExtensionContext) => Promise<void> | void): void;
  on(event: "session_compact", handler: (event: SkelnSessionCompactEvent, context: ExtensionContext) => Promise<void> | void): void;
  on(event: "session_before_tree", handler: (event: SkelnSessionBeforeTreeEvent, context: ExtensionContext) => Promise<void> | void): void;
  on(event: "session_tree", handler: (event: SkelnSessionTreeEvent, context: ExtensionContext) => Promise<void> | void): void;
  on(event: "session_shutdown", handler: (event: SkelnSessionShutdownEvent, context: ExtensionContext) => Promise<void> | void): void;
  on(
    event: "before_agent_start",
    handler: (
      event: { type: "before_agent_start"; prompt: string; systemPrompt: string },
      context: ExtensionContext,
    ) => Promise<ReturnType<typeof handleAgenrSkelnBeforeAgentStart>> | ReturnType<typeof handleAgenrSkelnBeforeAgentStart>,
  ): void;
  on(
    event: "tool_result",
    handler: (
      event: { isError: boolean; toolName: string; details: unknown },
      context: ExtensionContext,
    ) => Promise<{ isError?: boolean } | undefined> | { isError?: boolean } | undefined,
  ): void;
};

/**
 * Registers agenr durable-memory tools and lifecycle hooks on a Skeln extension API.
 *
 * @param skeln - Skeln extension API for the active runtime.
 * @param options - Optional path overrides and host scope callback.
 */
export function registerAgenrSkelnMemory(skeln: ExtensionAPI, options: RegisterAgenrSkelnMemoryOptions = {}): AgenrSkelnMemoryController {
  const memoryPolicySetting = readSkelnMemoryPolicySetting(skeln);
  if (!memoryPolicySetting.ok) {
    console.warn(`[agenr] invalid memoryPolicy setting: ${memoryPolicySetting.error}`);
  }

  const config: AgenrSkelnConfig = {
    dbPath: options.dbPath ?? readStringSetting(skeln, "dbPath"),
    configPath: options.configPath ?? readStringSetting(skeln, "configPath"),
    memoryPolicy: mergeSkelnMemoryPolicy(memoryPolicySetting.ok ? memoryPolicySetting.value : undefined, options.memoryPolicy),
    ...(options.featureFlags ? { featureFlags: options.featureFlags } : {}),
  };
  const servicesPromise = createAgenrSkelnServices(config);
  const scopeTracker = createSkelnSessionScopeTracker();
  const sessionStartTracker = createSessionStartTracker();
  const lifecycle = skeln as ExtensionAPI & SkelnLifecycleHookRegistrar;

  const resolveScope = async (context: ExtensionContext) => resolveCurrentSkelnSessionScope(context, scopeTracker, options);

  void servicesPromise.catch((error: unknown) => {
    console.error(`[agenr] startup failed: ${formatErrorMessage(error)}`);
  });

  registerAgenrSkelnTools(skeln, servicesPromise, resolveScope);
  registerAgenrSkelnFailureBoundary(lifecycle);
  registerAgenrSkelnInjectionHooks(lifecycle, scopeTracker, servicesPromise, sessionStartTracker, resolveScope);
  registerAgenrSkelnSessionMemoryHooks(lifecycle, scopeTracker, servicesPromise, resolveScope);
  registerAgenrSkelnSubagentFindingHooks(lifecycle, servicesPromise, resolveScope);

  return {
    executeWorkCommand: (context, params) => executeAgenrSkelnWorkCommand(servicesPromise, resolveScope, context, params),
  };
}

/** Default Skeln extension factory for direct `@agenr/skeln-plugin` loads. */
export default function extension(skeln: ExtensionAPI): void {
  registerAgenrSkelnMemory(skeln);
}

/** Registers session-start scope tracking and before-agent-start memory injection. */
function registerAgenrSkelnInjectionHooks(
  skeln: SkelnLifecycleHookRegistrar,
  scopeTracker: SkelnSessionScopeTracker,
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>,
  sessionStartTracker: ReturnType<typeof createSessionStartTracker>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
): void {
  skeln.on("session_start", async (event, context) => {
    try {
      const scope = await resolveScope(context);
      rememberSkelnSessionStart(scopeTracker, sessionStartTracker, scope, event.previousSessionFile);

      const services = await servicesPromise;
      logSessionMemoryTriggerResult(await services.routeSessionMemoryTrigger(buildSkelnSessionStartTriggerEvent(scope, event)));
    } catch (error) {
      console.warn(`[agenr] session_start scope failed: ${formatErrorMessage(error)}`);
    }
  });

  skeln.on("before_agent_start", async (event, context) =>
    handleAgenrSkelnBeforeAgentStart(event, context, {
      servicesPromise,
      sessionStartTracker,
      resolveScope,
    }),
  );
}

/** Registers feature-gated session-memory lifecycle intake hooks. */
function registerAgenrSkelnSessionMemoryHooks(
  skeln: SkelnLifecycleHookRegistrar,
  scopeTracker: SkelnSessionScopeTracker,
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
): void {
  skeln.on("session_before_fork", async (event, context) => {
    await routeScopedSessionMemoryTrigger(servicesPromise, resolveScope, context, (scope) => buildSkelnSessionBeforeForkTriggerEvent(scope, event));
  });

  skeln.on("session_before_compact", async (_event, context) => {
    await routeScopedSessionMemoryTrigger(servicesPromise, resolveScope, context, (scope) => buildSkelnSessionBeforeCompactTriggerEvent(scope));
  });

  skeln.on("session_compact", async (event, context) => {
    await routeScopedSessionMemoryTrigger(servicesPromise, resolveScope, context, (scope) => buildSkelnSessionCompactTriggerEvent(scope, event));
  });

  skeln.on("session_before_tree", async (event, context) => {
    await routeScopedSessionMemoryTrigger(servicesPromise, resolveScope, context, (scope) => buildSkelnSessionBeforeTreeTriggerEvent(scope, event));
  });

  skeln.on("session_tree", async (event, context) => {
    await routeScopedSessionMemoryTrigger(servicesPromise, resolveScope, context, (scope) => buildSkelnSessionTreeTriggerEvent(scope, event));
  });

  skeln.on("session_shutdown", async (event, context) => {
    await handleSkelnSessionShutdown(servicesPromise, scopeTracker, resolveScope, event, context);
  });
}

/** Routes shutdown lifecycle intake, scope cleanup, and shutdown episode dispatch. */
async function handleSkelnSessionShutdown(
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>,
  scopeTracker: SkelnSessionScopeTracker,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
  event: SkelnSessionShutdownEvent,
  context: ExtensionContext,
): Promise<void> {
  await routeScopedSessionMemoryTrigger(servicesPromise, resolveScope, context, (scope) => buildSkelnSessionShutdownTriggerEvent(scope, event));
  // Shutdown episode work uses a synchronous transcript snapshot, not the scope tracker.
  clearTrackedSkelnScope(scopeTracker, context);
  await scheduleSkelnSessionShutdownEpisodeWrite({ event, context, servicesPromise });
}

/** Registers bounded subagent finding capture for active working sets. */
function registerAgenrSkelnSubagentFindingHooks(
  skeln: SkelnLifecycleHookRegistrar,
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
): void {
  skeln.on("tool_result", async (event, context) => {
    await recordSkelnSubagentFindings(servicesPromise, resolveScope, context, event);
    return undefined;
  });
}

/** Routes one scoped session-memory trigger and logs non-fatal failures. */
async function routeScopedSessionMemoryTrigger(
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
  context: ExtensionContext,
  buildEvent: (scope: AgenrSkelnSessionScope) => SessionMemoryTriggerEvent,
): Promise<void> {
  try {
    const scope = await resolveScope(context);
    const services = await servicesPromise;
    logSessionMemoryTriggerResult(await services.routeSessionMemoryTrigger(buildEvent(scope)));
  } catch (error) {
    console.warn(`[agenr] session-memory trigger failed: ${formatErrorMessage(error)}`);
  }
}

/** Resolves one active Skeln session scope from host context and optional overrides. */
async function resolveCurrentSkelnSessionScope(
  context: ExtensionContext,
  scopeTracker: SkelnSessionScopeTracker,
  options: RegisterAgenrSkelnMemoryOptions,
): Promise<AgenrSkelnSessionScope> {
  const sessionId = String(context.sessionManager.getSessionId());
  const tracked = scopeTracker.getSessionScope(sessionId);
  const defaults = tracked
    ? {
        cwd: tracked.cwd,
        sessionKey: tracked.sessionKey,
        ...(tracked.gitRoot ? { gitRoot: tracked.gitRoot } : {}),
        ...(tracked.gitBranch ? { gitBranch: tracked.gitBranch } : {}),
        ...(tracked.project ? { project: tracked.project } : {}),
        ...(tracked.conversationKey ? { conversationKey: tracked.conversationKey } : {}),
      }
    : buildSkelnHostContext({
        sessionId,
        cwd: resolveContextCwd(context),
      });
  const override = options.getHostContext ? await options.getHostContext(context) : undefined;
  return toSkelnSessionScope(mergeSkelnHostContext(defaults, override), sessionId);
}

/** Records session scope and predecessor facts for later injection hooks. */
function rememberSkelnSessionStart(
  scopeTracker: SkelnSessionScopeTracker,
  sessionStartTracker: ReturnType<typeof createSessionStartTracker>,
  scope: AgenrSkelnSessionScope,
  previousSessionFile: string | undefined,
): void {
  scopeTracker.rememberSessionStart(scope);
  sessionStartTracker.rememberSessionStart(scope.sessionId, scope.sessionKey, previousSessionFile);
}

/** Returns the active CWD from the Skeln context while tolerating older host shapes. */
function resolveContextCwd(context: ExtensionContext): string {
  return context.cwd || context.sessionManager.getCwd();
}

/** Removes remembered scope facts for a session that has ended. */
function clearTrackedSkelnScope(scopeTracker: SkelnSessionScopeTracker, context: ExtensionContext): void {
  try {
    const sessionId = String(context.sessionManager.getSessionId());
    scopeTracker.clear(sessionId);
  } catch {
    // Older or partial Skeln contexts can still shut down services safely.
  }
}

/** Reads optional string settings from Skeln package configuration. */
function readStringSetting(skeln: ExtensionAPI, key: string): string | undefined {
  const value = skeln.getSetting(key);
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Marks structured agenr failed tool details as Skeln tool errors via the tool_result hook. */
function registerAgenrSkelnFailureBoundary(skeln: SkelnLifecycleHookRegistrar): void {
  skeln.on("tool_result", (event) => {
    if (event.isError || !isAgenrToolName(event.toolName) || !isFailedAgenrToolDetails(event.details)) {
      return undefined;
    }

    return { isError: true };
  });
}

/** Checks whether one tool-result event belongs to this extension. */
function isAgenrToolName(toolName: string): boolean {
  return (
    toolName === "agenr_store" ||
    toolName === "agenr_recall" ||
    toolName === "agenr_fetch" ||
    toolName === "agenr_update" ||
    toolName === "agenr_work" ||
    toolName === "get_goal" ||
    toolName === "create_goal" ||
    toolName === "update_goal"
  );
}

/** Checks the shared structured details status emitted by agenr tools. */
function isFailedAgenrToolDetails(details: unknown): boolean {
  return typeof details === "object" && details !== null && "status" in details && details.status === "failed";
}
