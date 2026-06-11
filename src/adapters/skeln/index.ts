import type { ExtensionAPI, ExtensionContext } from "./skeln-types.js";

import { formatErrorMessage } from "../shared/errors.js";
import { logSessionMemoryTriggerResult } from "../shared/session-memory-routing.js";
import { createSessionLifecycleIntakeTracker } from "../../app/plugin-runtime/session-lifecycle-intake.js";
import { createSessionStartTracker } from "../../app/plugin-runtime/session-tracking.js";
import { createCompactionPromptTracker } from "../shared/compaction-prompt-tracker.js";
import { mergeSkelnMemoryPolicy, readSkelnMemoryPolicySetting } from "./config.js";
import { readSkelnGoalsSetting } from "./config.js";
import { handleAgenrSkelnBeforeAgentStart } from "./hooks/before-agent-start.js";
import { handleSkelnSessionBeforeCompact } from "./hooks/compaction-handlers.js";
import { routeSkelnSessionMemoryTrigger } from "./hooks/session-memory-routing.js";
import {
  buildSkelnSessionBeforeForkTriggerEvent,
  buildSkelnSessionBeforeTreeTriggerEvent,
  buildSkelnSessionCompactTriggerEvent,
  buildSkelnSessionShutdownTriggerEvent,
  buildSkelnSessionStartTriggerEvent,
  buildSkelnSessionTreeTriggerEvent,
  type SkelnSessionBeforeCompactEvent,
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
import { closeSkelnSessionWorkingSet, ensureSkelnSessionWorkingSet } from "./session/working-set-lifecycle.js";
import { registerAgenrSkelnTools } from "./tools/index.js";
import type { AgenrSkelnLogger, AgenrSkelnSessionScope, RegisterAgenrSkelnMemoryOptions } from "./types.js";
import { executeAgenrSkelnGoalContinuationCommand } from "./goal-continuation-command.js";
import { executeAgenrSkelnWorkCommand, type AgenrSkelnMemoryController } from "./work-command.js";

export type { AgenrSkelnConfig, AgenrSkelnServices } from "./runtime.js";
export type { AgenrSkelnLogger, AgenrSkelnSessionScope, RegisterAgenrSkelnMemoryOptions, SkelnHostContext } from "./types.js";
export type {
  GoalContinuationCancelReason,
  GoalContinuationCommand,
  GoalContinuationHostPort,
  GoalContinuationHostResult,
  GoalContinuationResult,
  GoalContinuationScheduleReason,
} from "../../app/goal-continuation/service.js";
export type { AgenrSkelnGoalContinuationCommandParams, AgenrSkelnGoalContinuationScheduleCommandParams } from "./goal-continuation-command.js";
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
  on(event: "session_before_compact", handler: (event: SkelnSessionBeforeCompactEvent, context: ExtensionContext) => Promise<void> | void): void;
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
  const logger = resolveAgenrSkelnLogger(skeln, options.logger);
  const memoryPolicySetting = readSkelnMemoryPolicySetting(skeln);
  if (!memoryPolicySetting.ok) {
    logger.warn(`[agenr] invalid memoryPolicy setting: ${memoryPolicySetting.error}`);
  }
  const goalsSetting = readSkelnGoalsSetting(skeln);
  if (!goalsSetting.ok) {
    logger.warn(`[agenr] invalid goals setting: ${goalsSetting.error}`);
  }

  const config: AgenrSkelnConfig = {
    dbPath: options.dbPath ?? readStringSetting(skeln, "dbPath"),
    configPath: options.configPath ?? readStringSetting(skeln, "configPath"),
    memoryPolicy: mergeSkelnMemoryPolicy(memoryPolicySetting.ok ? memoryPolicySetting.value : undefined, options.memoryPolicy),
    goals: options.goals ?? (goalsSetting.ok ? goalsSetting.value : true),
    ...(options.featureFlags ? { featureFlags: options.featureFlags } : {}),
    ...(options.goalContinuationHostPort ? { goalContinuationHostPort: options.goalContinuationHostPort } : {}),
  };
  const servicesPromise = createAgenrSkelnServices(config);
  const scopeTracker = createSkelnSessionScopeTracker();
  const sessionStartTracker = createSessionStartTracker();
  const compactionPromptTracker = createCompactionPromptTracker();
  const lifecycleIntakeTracker = createSessionLifecycleIntakeTracker();
  const lifecycle = skeln as ExtensionAPI & SkelnLifecycleHookRegistrar;

  const resolveScope = async (context: ExtensionContext) => resolveCurrentSkelnSessionScope(context, scopeTracker, options);

  void servicesPromise.catch((error: unknown) => {
    logger.error(`[agenr] startup failed: ${formatErrorMessage(error)}`);
  });

  registerAgenrSkelnTools(skeln, servicesPromise, resolveScope, config.goals ?? true);
  registerAgenrSkelnFailureBoundary(lifecycle);
  registerAgenrSkelnInjectionHooks(
    lifecycle,
    scopeTracker,
    servicesPromise,
    sessionStartTracker,
    compactionPromptTracker,
    lifecycleIntakeTracker,
    resolveScope,
    logger,
  );
  registerAgenrSkelnSessionMemoryHooks(lifecycle, scopeTracker, servicesPromise, resolveScope, compactionPromptTracker, lifecycleIntakeTracker, logger);
  registerAgenrSkelnSubagentFindingHooks(lifecycle, servicesPromise, resolveScope);

  return {
    executeWorkCommand: (context, params) => executeAgenrSkelnWorkCommand(servicesPromise, resolveScope, context, params),
    executeGoalContinuationCommand: (context, params) => executeAgenrSkelnGoalContinuationCommand(servicesPromise, resolveScope, context, params),
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
  compactionPromptTracker: ReturnType<typeof createCompactionPromptTracker>,
  lifecycleIntakeTracker: ReturnType<typeof createSessionLifecycleIntakeTracker>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
  logger: AgenrSkelnLogger,
): void {
  skeln.on("session_start", async (event, context) => {
    try {
      const scope = await resolveScope(context);
      rememberSkelnSessionStart(scopeTracker, scope);
      await ensureSkelnSessionWorkingSet(servicesPromise, scope, logger);

      await lifecycleIntakeTracker.track(
        scope.sessionId,
        scope.sessionKey,
        (async () => {
          const services = await servicesPromise;
          logSessionMemoryTriggerResult(await services.routeSessionMemoryTrigger(buildSkelnSessionStartTriggerEvent(scope, event)));
        })(),
      );
    } catch (error) {
      logger.warn(`[agenr] session_start scope failed: ${formatErrorMessage(error)}`);
    }
  });

  skeln.on("before_agent_start", async (event, context) =>
    handleAgenrSkelnBeforeAgentStart(event, context, {
      servicesPromise,
      sessionStartTracker,
      compactionPromptTracker,
      lifecycleIntakeTracker,
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
  compactionPromptTracker: ReturnType<typeof createCompactionPromptTracker>,
  lifecycleIntakeTracker: ReturnType<typeof createSessionLifecycleIntakeTracker>,
  logger: AgenrSkelnLogger,
): void {
  skeln.on("session_before_fork", async (event, context) => {
    const scope = await resolveScope(context);
    await lifecycleIntakeTracker.track(
      scope.sessionId,
      scope.sessionKey,
      routeSkelnSessionMemoryTrigger(servicesPromise, resolveScope, context, (scope) => buildSkelnSessionBeforeForkTriggerEvent(scope, event)),
    );
  });

  skeln.on("session_before_compact", async (event, context) => {
    const scope = await resolveScope(context);
    await lifecycleIntakeTracker.track(scope.sessionId, scope.sessionKey, handleSkelnSessionBeforeCompact(event, context, servicesPromise, resolveScope));
  });

  skeln.on("session_compact", async (event, context) => {
    const scope = await resolveScope(context);
    await lifecycleIntakeTracker.track(
      scope.sessionId,
      scope.sessionKey,
      routeSkelnSessionMemoryTrigger(servicesPromise, resolveScope, context, (scope) => buildSkelnSessionCompactTriggerEvent(scope, event)),
    );
  });

  skeln.on("session_before_tree", async (event, context) => {
    const scope = await resolveScope(context);
    await lifecycleIntakeTracker.track(
      scope.sessionId,
      scope.sessionKey,
      routeSkelnSessionMemoryTrigger(servicesPromise, resolveScope, context, (scope) => buildSkelnSessionBeforeTreeTriggerEvent(scope, event)),
    );
  });

  skeln.on("session_tree", async (event, context) => {
    const scope = await resolveScope(context);
    await lifecycleIntakeTracker.track(
      scope.sessionId,
      scope.sessionKey,
      routeSkelnSessionMemoryTrigger(servicesPromise, resolveScope, context, (scope) => buildSkelnSessionTreeTriggerEvent(scope, event)),
    );
  });

  skeln.on("session_shutdown", async (event, context) => {
    await handleSkelnSessionShutdown(servicesPromise, scopeTracker, resolveScope, event, context, compactionPromptTracker, lifecycleIntakeTracker, logger);
  });
}

/** Routes shutdown lifecycle intake, scope cleanup, and shutdown episode dispatch. */
async function handleSkelnSessionShutdown(
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>,
  scopeTracker: SkelnSessionScopeTracker,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
  event: SkelnSessionShutdownEvent,
  context: ExtensionContext,
  compactionPromptTracker: ReturnType<typeof createCompactionPromptTracker>,
  lifecycleIntakeTracker: ReturnType<typeof createSessionLifecycleIntakeTracker>,
  logger: AgenrSkelnLogger,
): Promise<void> {
  const scope = await resolveShutdownScope(resolveScope, context);
  let closedWorkingSetId: string | undefined;
  if (scope) {
    try {
      await lifecycleIntakeTracker.track(
        scope.sessionId,
        scope.sessionKey,
        routeSkelnSessionMemoryTrigger(servicesPromise, resolveScope, context, (scope) => buildSkelnSessionShutdownTriggerEvent(scope, event)),
      );
    } catch {
      // Keep shutdown cleanup best-effort even when checkpoint intake fails.
    }

    const closeResult = await closeSkelnSessionWorkingSet(servicesPromise, scope, event, logger);
    closedWorkingSetId = closeResult?.workingSet.id;
    compactionPromptTracker.clear(scope.sessionId, scope.sessionKey);
    try {
      await lifecycleIntakeTracker.clear(scope.sessionId, scope.sessionKey);
    } catch {
      // Ignore tracker cleanup failures during host shutdown.
    }
  }

  // Shutdown episode work uses a synchronous transcript snapshot, not the scope tracker.
  clearTrackedSkelnScope(scopeTracker, context);
  await scheduleSkelnSessionShutdownEpisodeWrite({
    event,
    context,
    servicesPromise,
    ...(closedWorkingSetId ? { workingSetId: closedWorkingSetId } : {}),
    logger,
  });
}

/** Resolves shutdown scope without blocking transcript snapshot cleanup on failure. */
async function resolveShutdownScope(
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
  context: ExtensionContext,
): Promise<AgenrSkelnSessionScope | undefined> {
  try {
    return await resolveScope(context);
  } catch {
    return undefined;
  }
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

/** Records session scope facts for later injection hooks. */
function rememberSkelnSessionStart(scopeTracker: SkelnSessionScopeTracker, scope: AgenrSkelnSessionScope): void {
  scopeTracker.rememberSessionStart(scope);
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

/** Resolves the Skeln logger from explicit options, host API, or console. */
function resolveAgenrSkelnLogger(skeln: ExtensionAPI, logger?: AgenrSkelnLogger): AgenrSkelnLogger {
  if (logger) {
    return logger;
  }

  const hostLogger = (skeln as ExtensionAPI & { logger?: Partial<AgenrSkelnLogger> }).logger;
  return {
    info: typeof hostLogger?.info === "function" ? hostLogger.info.bind(hostLogger) : console.info.bind(console),
    warn: typeof hostLogger?.warn === "function" ? hostLogger.warn.bind(hostLogger) : console.warn.bind(console),
    error: typeof hostLogger?.error === "function" ? hostLogger.error.bind(hostLogger) : console.error.bind(console),
  };
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
