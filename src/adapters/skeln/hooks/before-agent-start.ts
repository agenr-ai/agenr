import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "skeln";

import { runBeforeTurn } from "../../../app/before-turn/index.js";
import { runSessionStart } from "../../../app/session-start/index.js";
import type { SessionStartTracker } from "../../../app/plugin-runtime/session-tracking.js";
import { formatAgenrBeforeTurnRecall } from "../../shared/injection/before-turn-format.js";
import { formatAgenrSessionStartRecall } from "../../shared/injection/session-start-format.js";
import type { AgenrSkelnServices } from "../runtime.js";
import type { AgenrSkelnSessionScope } from "../types.js";
import { buildAgenrSkelnMemoryPromptSection } from "../format/prompt-section.js";
import { resolveBeforeTurnPolicy, resolveSessionStartPolicy } from "../../shared/injection/policy.js";
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
  systemPrompt?: string;
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
 * @returns Hidden user messages and optional system-prompt mutation, or `undefined` when nothing injects.
 */
export async function handleAgenrSkelnBeforeAgentStart(
  event: AgenrSkelnBeforeAgentStartEvent,
  context: ExtensionContext,
  deps: AgenrSkelnBeforeAgentStartDeps,
): Promise<AgenrSkelnBeforeAgentStartResult | undefined> {
  const scope = await deps.resolveScope(context);
  const doctrine = buildAgenrSkelnMemoryPromptSection().join("\n");
  const systemPromptWithDoctrine = appendPromptSection(event.systemPrompt, doctrine);
  const trackerState = deps.sessionStartTracker.consume(scope.sessionId, scope.sessionKey);

  if (trackerState.isFirst) {
    return resolveSessionStartInjection(scope, systemPromptWithDoctrine, deps.servicesPromise);
  }

  return resolveBeforeTurnInjection(event, scope, systemPromptWithDoctrine, context, deps.servicesPromise);
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

async function resolveSessionStartInjection(
  scope: AgenrSkelnSessionScope,
  systemPrompt: string,
  servicesPromise: Promise<AgenrSkelnServices>,
): Promise<AgenrSkelnBeforeAgentStartResult | undefined> {
  try {
    const services = await servicesPromise;
    const sessionStartPatch = await runSessionStart(
      {
        sessionKey: scope.sessionKey,
        policy: resolveSessionStartPolicy(services.skelnConfig.memoryPolicy),
      },
      services.sessionStart,
    );
    const injectionText = formatAgenrSessionStartRecall(sessionStartPatch);
    if (injectionText.length === 0) {
      return { systemPrompt };
    }

    return {
      message: buildAgenrSkelnInjectionMessage(injectionText),
      systemPrompt,
    };
  } catch (error) {
    logInjectionFailure("session-start", scope, error);
    return { systemPrompt };
  }
}

async function resolveBeforeTurnInjection(
  event: AgenrSkelnBeforeAgentStartEvent,
  scope: AgenrSkelnSessionScope,
  systemPrompt: string,
  context: ExtensionContext,
  servicesPromise: Promise<AgenrSkelnServices>,
): Promise<AgenrSkelnBeforeAgentStartResult | undefined> {
  const services = await servicesPromise;
  if (services.skelnConfig.memoryPolicy?.beforeTurn?.enabled === false) {
    return undefined;
  }

  const currentTurnText = normalizePromptText(event.prompt);
  if (!currentTurnText) {
    return undefined;
  }

  try {
    const branchMessages = context.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    const beforeTurnPatch = await runBeforeTurn(
      {
        sessionKey: scope.sessionKey,
        currentTurnText,
        recentTurns: extractRecentTurnsFromMessages(branchMessages),
        policy: resolveBeforeTurnPolicy(services.skelnConfig.memoryPolicy),
      },
      services.beforeTurn,
    );
    const injectionText = formatAgenrBeforeTurnRecall(beforeTurnPatch);
    if (injectionText.length === 0) {
      return undefined;
    }

    return {
      message: buildAgenrSkelnInjectionMessage(injectionText),
      systemPrompt,
    };
  } catch (error) {
    logInjectionFailure("before-turn", scope, error);
    return undefined;
  }
}

function logInjectionFailure(phase: "session-start" | "before-turn", scope: AgenrSkelnSessionScope, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[agenr] ${phase} recall failed for session=${scope.sessionId} key=${scope.sessionKey}: ${message}`);
}
