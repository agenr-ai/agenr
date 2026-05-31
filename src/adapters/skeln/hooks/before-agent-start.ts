import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "skeln";

import { shouldInjectWorkingContext, toWorkingContextAuditPointer, type WorkingContextAuditPointer } from "../../../app/working-memory/projection.js";

import { runBeforeTurn } from "../../../app/before-turn/index.js";
import { runSessionStart } from "../../../app/session-start/index.js";
import type { SessionStartTracker } from "../../../app/plugin-runtime/session-tracking.js";
import { formatAgenrBeforeTurnRecall } from "../../shared/injection/before-turn-format.js";
import { formatAgenrSessionStartRecall } from "../../shared/injection/session-start-format.js";
import type { AgenrSkelnServices } from "../runtime.js";
import { toWorkingScopeFromSkelnSession } from "../session/scope.js";
import { extractSkelnBeforeTurnBranchMessages } from "../session/branch-compaction.js";
import type { AgenrSkelnSessionScope } from "../types.js";
import { buildAgenrSkelnMemoryPromptSection } from "../format/prompt-section.js";
import {
  buildBeforeAgentStartMemoryTrace,
  traceMemoryFailed,
  traceMemorySkipped,
  traceWorkingContextInjected,
  type MemoryTraceEvent,
} from "../memory-trace.js";
import { resolveBeforeTurnPolicy, resolveSessionStartPolicy, resolveWorkingContextGate } from "../../shared/injection/policy.js";
import { extractRecentTurnsFromMessages, normalizePromptText } from "../../shared/injection/message-text.js";

/** Skeln before_agent_start event payload used by the agenr adapter. */
export interface AgenrSkelnBeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  systemPrompt: string;
}

/** Skeln before_agent_start result payload returned by the agenr adapter. */
export interface AgenrSkelnBeforeAgentStartResult {
  message?: AgentMessage;
  messages?: AgentMessage[];
  transientMessages?: AgentMessage[];
  workingContextAudit?: WorkingContextAuditPointer;
  memoryTrace?: MemoryTraceEvent[];
  systemPrompt?: string;
}

/** Working-context resolution including structured trace metadata. */
interface WorkingContextResolution {
  transientMessages?: AgentMessage[];
  workingContextAudit?: WorkingContextAuditPointer;
  trace: MemoryTraceEvent;
}

/** Inputs used to compose one Skeln before_agent_start hook result. */
interface SkelnBeforeAgentStartComposeInput {
  baseSystemPrompt: string;
  systemPrompt: string;
  recallKind: "session_start_recall" | "before_turn_recall";
  recallText?: string;
  recallSkippedReason?: string;
  recallFailureReason?: string;
  workingInjection?: WorkingContextResolution;
}

/** Dependencies required by the Skeln before_agent_start handler. */
export interface AgenrSkelnBeforeAgentStartDeps {
  servicesPromise: Promise<AgenrSkelnServices>;
  sessionStartTracker: SessionStartTracker;
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>;
}

/**
 * Runs agenr session-start or before-turn recall and injects the result into one Skeln turn.
 *
 * @param event - Current before-agent-start payload from Skeln.
 * @param context - Active extension context with session branch access.
 * @param deps - Shared services, session-start tracker, and scope resolver.
 * @returns Hidden user messages, transient working context, and optional system-prompt mutation.
 */
export async function handleAgenrSkelnBeforeAgentStart(
  event: AgenrSkelnBeforeAgentStartEvent,
  context: ExtensionContext,
  deps: AgenrSkelnBeforeAgentStartDeps,
): Promise<AgenrSkelnBeforeAgentStartResult> {
  const scope = await deps.resolveScope(context);
  const doctrine = buildAgenrSkelnMemoryPromptSection().join("\n");
  const systemPromptWithDoctrine = appendPromptSection(event.systemPrompt, doctrine);
  const trackerState = deps.sessionStartTracker.consume(scope.sessionId, scope.sessionKey);

  if (trackerState.isFirst) {
    return resolveSessionStartInjection(scope, event.systemPrompt, systemPromptWithDoctrine, deps.servicesPromise);
  }

  return resolveBeforeTurnInjection(event, scope, event.systemPrompt, systemPromptWithDoctrine, context, deps.servicesPromise);
}

/** Builds one hidden user message carrying injected memory context. */
export function buildAgenrSkelnInjectionMessage(content: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: content }],
    timestamp: Date.now(),
  };
}

/** Appends one prompt section when it is not already present. */
function appendPromptSection(systemPrompt: string, section: string): string {
  const trimmedSection = section.trim();
  if (trimmedSection.length === 0 || systemPrompt.includes(trimmedSection)) {
    return systemPrompt;
  }

  return `${systemPrompt.trimEnd()}\n\n${trimmedSection}`;
}

/**
 * Resolves the first-turn Skeln session-start memory injection.
 */
async function resolveSessionStartInjection(
  scope: AgenrSkelnSessionScope,
  baseSystemPrompt: string,
  systemPrompt: string,
  servicesPromise: Promise<AgenrSkelnServices>,
): Promise<AgenrSkelnBeforeAgentStartResult> {
  let workingInjection: WorkingContextResolution | undefined;

  try {
    const services = await servicesPromise;
    workingInjection = await resolveWorkingContextInjection(services, scope, `skeln:session-start:${scope.sessionKey}`);
    if (services.skelnConfig.memoryPolicy?.sessionStart?.enabled === false) {
      return composeSkelnBeforeAgentStartResult({
        baseSystemPrompt,
        systemPrompt,
        recallKind: "session_start_recall",
        recallSkippedReason: "memoryPolicy.sessionStart.enabled=false",
        workingInjection,
      });
    }

    // Predecessor continuity injection is deferred until Skeln adopts the OpenClaw-style
    // read-time continuity path (filesystem sidecar + transcript tail), not DB artifacts.
    const sessionStartPatch = await runSessionStart(
      {
        sessionKey: scope.sessionKey,
        policy: resolveSessionStartPolicy(services.skelnConfig.memoryPolicy),
      },
      services.sessionStart,
    );
    return composeSkelnBeforeAgentStartResult({
      baseSystemPrompt,
      systemPrompt,
      recallKind: "session_start_recall",
      recallText: formatAgenrSessionStartRecall(sessionStartPatch),
      workingInjection,
    });
  } catch (error) {
    logInjectionFailure("session-start", scope, error);
    return composeSkelnBeforeAgentStartResult({
      baseSystemPrompt,
      systemPrompt,
      recallKind: "session_start_recall",
      recallFailureReason: error instanceof Error ? error.message : String(error),
      workingInjection,
    });
  }
}

/**
 * Resolves proactive before-turn memory injection for later Skeln turns.
 */
async function resolveBeforeTurnInjection(
  event: AgenrSkelnBeforeAgentStartEvent,
  scope: AgenrSkelnSessionScope,
  baseSystemPrompt: string,
  systemPrompt: string,
  context: ExtensionContext,
  servicesPromise: Promise<AgenrSkelnServices>,
): Promise<AgenrSkelnBeforeAgentStartResult> {
  const services = await servicesPromise;
  const workingInjection = await resolveWorkingContextInjection(services, scope, `skeln:before-turn:${scope.sessionKey}`);
  if (services.skelnConfig.memoryPolicy?.beforeTurn?.enabled === false) {
    return composeSkelnBeforeAgentStartResult({
      baseSystemPrompt,
      systemPrompt,
      recallKind: "before_turn_recall",
      recallSkippedReason: "memoryPolicy.beforeTurn.enabled=false",
      workingInjection,
    });
  }

  const currentTurnText = normalizePromptText(event.prompt);
  if (!currentTurnText) {
    return composeSkelnBeforeAgentStartResult({
      baseSystemPrompt,
      systemPrompt,
      recallKind: "before_turn_recall",
      recallSkippedReason: "empty turn prompt",
      workingInjection,
    });
  }

  try {
    const branchMessages = extractSkelnBeforeTurnBranchMessages(context.sessionManager.getBranch());
    const beforeTurnPatch = await runBeforeTurn(
      {
        sessionKey: scope.sessionKey,
        currentTurnText,
        recentTurns: extractRecentTurnsFromMessages(branchMessages),
        policy: resolveBeforeTurnPolicy(services.skelnConfig.memoryPolicy),
      },
      services.beforeTurn,
    );
    return composeSkelnBeforeAgentStartResult({
      baseSystemPrompt,
      systemPrompt,
      recallKind: "before_turn_recall",
      recallText: formatAgenrBeforeTurnRecall(beforeTurnPatch),
      workingInjection,
    });
  } catch (error) {
    logInjectionFailure("before-turn", scope, error);
    return composeSkelnBeforeAgentStartResult({
      baseSystemPrompt,
      systemPrompt,
      recallKind: "before_turn_recall",
      recallFailureReason: error instanceof Error ? error.message : String(error),
      workingInjection,
    });
  }
}

/** Merges recall and working-context injections into one Skeln hook result. */
function composeSkelnBeforeAgentStartResult(input: SkelnBeforeAgentStartComposeInput): AgenrSkelnBeforeAgentStartResult {
  const recallText = input.recallText?.trim();
  const memoryTrace = buildBeforeAgentStartMemoryTrace({
    baseSystemPrompt: input.baseSystemPrompt,
    systemPrompt: input.systemPrompt,
    recallKind: input.recallKind,
    recallText,
    recallSkippedReason: input.recallSkippedReason,
    recallFailureReason: input.recallFailureReason,
    workingContextTrace: input.workingInjection?.trace,
  });

  return {
    systemPrompt: input.systemPrompt,
    ...(recallText ? { message: buildAgenrSkelnInjectionMessage(recallText) } : {}),
    ...(input.workingInjection?.transientMessages ? { transientMessages: input.workingInjection.transientMessages } : {}),
    ...(input.workingInjection?.workingContextAudit ? { workingContextAudit: input.workingInjection.workingContextAudit } : {}),
    ...(memoryTrace.length > 0 ? { memoryTrace } : {}),
  };
}

/**
 * Resolves a non-persistent working-memory projection for one Skeln turn.
 */
async function resolveWorkingContextInjection(
  services: AgenrSkelnServices,
  scope: AgenrSkelnSessionScope,
  sourceRef: string,
): Promise<WorkingContextResolution> {
  const gate = resolveWorkingContextGate(services.capabilities.workingMemory, services.skelnConfig.memoryPolicy);
  if (!gate.ok) {
    return { trace: traceMemorySkipped("working_context", gate.reason) };
  }

  return loadWorkingContextProjection(services, scope, sourceRef);
}

/** Loads and formats one working-context projection after policy gates pass. */
async function loadWorkingContextProjection(services: AgenrSkelnServices, scope: AgenrSkelnSessionScope, sourceRef: string): Promise<WorkingContextResolution> {
  try {
    const projection = await services.workingMemory.renderProjection({
      sourceRef,
      scope: toWorkingScopeFromSkelnSession(scope),
    });
    if (!shouldInjectWorkingContext(projection)) {
      const reason = projection.renderMode !== "full" ? "working projection stub" : "empty working projection";
      return { trace: traceMemorySkipped("working_context", reason) };
    }

    const workingContextAudit = toWorkingContextAuditPointer(projection);

    return {
      transientMessages: [buildAgenrSkelnInjectionMessage(projection.content)],
      ...(workingContextAudit ? { workingContextAudit } : {}),
      trace: traceWorkingContextInjected(workingContextAudit, projection.content),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[agenr] working-context projection failed for session=${scope.sessionId} key=${scope.sessionKey}: ${message}`);
    return { trace: traceMemoryFailed("working_context", message) };
  }
}

/**
 * Logs a non-fatal Skeln memory injection failure.
 */
function logInjectionFailure(phase: "session-start" | "before-turn", scope: AgenrSkelnSessionScope, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[agenr] ${phase} recall failed for session=${scope.sessionId} key=${scope.sessionKey}: ${message}`);
}
