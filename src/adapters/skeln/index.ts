import type { ExtensionAPI, ExtensionContext } from "skeln";

import { createSessionStartTracker } from "../../app/plugin-runtime/session-tracking.js";
import { mergeSkelnMemoryPolicy, readSkelnMemoryPolicySetting } from "./config.js";
import { handleAgenrSkelnBeforeAgentStart } from "./hooks/before-agent-start.js";
import { createAgenrSkelnServices } from "./runtime.js";
import type { AgenrSkelnConfig } from "./runtime.js";
import { buildSkelnHostContext, mergeSkelnHostContext, toSkelnSessionScope } from "./session/scope.js";
import { createSkelnSessionScopeTracker, type SkelnSessionScopeTracker } from "./session/state.js";
import { registerAgenrSkelnTools } from "./tools/index.js";
import type { AgenrSkelnSessionScope, RegisterAgenrSkelnMemoryOptions } from "./types.js";

export type { AgenrSkelnConfig, AgenrSkelnServices } from "./runtime.js";
export type { AgenrSkelnSessionScope, RegisterAgenrSkelnMemoryOptions, SkelnHostContext } from "./types.js";
export { createAgenrSkelnServices } from "./runtime.js";
export { handleAgenrSkelnBeforeAgentStart } from "./hooks/before-agent-start.js";

type SkelnLifecycleHookRegistrar = {
  on(event: "session_start", handler: (event: { previousSessionFile?: string }, context: ExtensionContext) => Promise<void> | void): void;
  on(
    event: "before_agent_start",
    handler: (
      event: { type: "before_agent_start"; prompt: string; systemPrompt: string },
      context: ExtensionContext,
    ) => Promise<ReturnType<typeof handleAgenrSkelnBeforeAgentStart> | undefined> | ReturnType<typeof handleAgenrSkelnBeforeAgentStart> | undefined,
  ): void;
  on(event: "tool_result", handler: (event: { isError: boolean; toolName: string; details: unknown }) => { isError?: boolean } | undefined): void;
};

/**
 * Registers agenr durable-memory tools and lifecycle hooks on a Skeln extension API.
 *
 * @param skeln - Skeln extension API for the active runtime.
 * @param options - Optional path overrides and host scope callback.
 */
export function registerAgenrSkelnMemory(skeln: ExtensionAPI, options: RegisterAgenrSkelnMemoryOptions = {}): void {
  const memoryPolicySetting = readSkelnMemoryPolicySetting(skeln);
  if (!memoryPolicySetting.ok) {
    console.warn(`[agenr] invalid memoryPolicy setting: ${memoryPolicySetting.error}`);
  }

  const config: AgenrSkelnConfig = {
    dbPath: options.dbPath ?? readStringSetting(skeln, "dbPath"),
    configPath: options.configPath ?? readStringSetting(skeln, "configPath"),
    memoryPolicy: mergeSkelnMemoryPolicy(memoryPolicySetting.ok ? memoryPolicySetting.value : undefined, options.memoryPolicy),
  };
  const servicesPromise = createAgenrSkelnServices(config);
  const scopeTracker = createSkelnSessionScopeTracker();
  const sessionStartTracker = createSessionStartTracker();
  const lifecycle = skeln as ExtensionAPI & SkelnLifecycleHookRegistrar;

  const resolveScope = async (context: ExtensionContext) => resolveCurrentSkelnSessionScope(context, scopeTracker, options);

  void servicesPromise.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[agenr] startup failed: ${message}`);
  });

  registerAgenrSkelnTools(skeln, servicesPromise, resolveScope);
  registerAgenrSkelnFailureBoundary(lifecycle);
  registerAgenrSkelnInjectionHooks(lifecycle, scopeTracker, servicesPromise, sessionStartTracker, resolveScope);

  skeln.on("session_shutdown", async (event, context) => {
    clearTrackedSkelnScope(scopeTracker, context);

    if (event.reason !== "quit") {
      return;
    }

    try {
      const services = await servicesPromise;
      await services.close();
    } catch {
      // Ignore startup failures during shutdown.
    }
  });
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[agenr] session_start scope failed: ${message}`);
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
  return toolName === "agenr_store" || toolName === "agenr_recall" || toolName === "agenr_update";
}

/** Checks the shared structured details status emitted by agenr tools. */
function isFailedAgenrToolDetails(details: unknown): boolean {
  return typeof details === "object" && details !== null && "status" in details && details.status === "failed";
}
