import fs from "node:fs";
import path from "node:path";

import type { AgentEvent } from "@mariozechner/pi-agent-core";

import type { SurgeonRunAction } from "../../core/surgeon/domain/action-types.js";
import { createLogger, type Logger } from "../../logger.js";

/**
 * Minimal budget snapshot contract consumed by the trace logger.
 *
 * The app-layer budget tracker satisfies this shape structurally.
 */
interface TraceBudgetTracker {
  totals(): {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    lastInputTokens: number;
  };
  remaining(): {
    currentContextTokens: number;
    contextLimit: number;
    remainingContextTokens: number;
    costCapUsd: number;
    remainingCostUsd: number;
  };
}

/**
 * Emits verbose surgeon agent traces to the console and optional trace file.
 */
export interface SurgeonTraceLogger {
  /**
   * Records one low-level agent event.
   *
   * @param event - Agent-loop event emitted by `pi-agent-core`.
   */
  onEvent(event: AgentEvent): void;

  /**
   * Records one high-level surgeon action with reasoning.
   *
   * @param action - Surgeon action payload to log.
   */
  logAction(action: SurgeonRunAction): void;

  /**
   * Releases any in-memory tracking held by the logger.
   */
  close(): void;
}

/**
 * Creates the surgeon trace logger used for verbose run diagnostics.
 *
 * @param options - Logging, file-trace, and budget reporting options.
 * @returns Trace logger instance for one surgeon run.
 */
export function createTraceLogger(options: { verbose: boolean; tracePath?: string; logger?: Logger; budgetTracker?: TraceBudgetTracker }): SurgeonTraceLogger {
  const logger = options.logger ?? createLogger("surgeon");
  const startedTools = new Map<string, number>();

  return {
    onEvent(event: AgentEvent): void {
      try {
        appendTrace(options.tracePath, event, logger);

        switch (event.type) {
          case "turn_start":
            logger.info("surgeon turn started");
            return;

          case "message_end":
            if (event.message.role !== "assistant") {
              return;
            }
            logAssistantMessage(logger, event, options.verbose);
            return;

          case "tool_execution_start":
            startedTools.set(event.toolCallId, Date.now());
            logger.info(options.verbose ? `tool ${event.toolName} start args=${safeStringify(event.args)}` : `tool ${event.toolName} start`);
            return;

          case "tool_execution_end":
            logToolExecutionEnd(logger, event, startedTools);
            return;

          case "turn_end":
            logTurnEnd(logger, options.budgetTracker);
            return;

          case "agent_end":
            logger.info(`agent end messages=${event.messages.length}`);
            return;

          default:
            return;
        }
      } catch (error) {
        logger.warn(`trace logger failed to record agent event: ${formatError(error)}`);
      }
    },

    logAction(action: SurgeonRunAction): void {
      try {
        appendTrace(
          options.tracePath,
          {
            type: "surgeon_action",
            action,
          },
          logger,
        );

        const reasoning = truncate(action.reasoning.trim(), 200);
        logger.info(`action ${action.actionType} entries=${action.entryIds.join(", ") || "(none)"}${reasoning ? ` reason="${reasoning}"` : ""}`);
      } catch (error) {
        logger.warn(`trace logger failed to record action: ${formatError(error)}`);
      }
    },

    close(): void {
      startedTools.clear();
    },
  };
}

/**
 * Logs one completed assistant message with usage and tool details.
 *
 * @param logger - Destination logger.
 * @param event - Agent message-end event.
 * @param verbose - Whether to emit the full assistant text.
 */
function logAssistantMessage(logger: Logger, event: Extract<AgentEvent, { type: "message_end" }>, verbose: boolean): void {
  if (!isAssistantMessage(event.message)) {
    return;
  }

  const text = extractAssistantText(event.message);
  const toolCalls = event.message.content.filter(
    (block): block is Extract<(typeof event.message.content)[number], { type: "toolCall" }> => block.type === "toolCall",
  );
  const usage = event.message.usage;
  const usageLine = `tokens in=${usage.input} out=${usage.output} total=${usage.totalTokens} cost=$${usage.cost.total.toFixed(4)}`;

  if (verbose) {
    logger.info(`assistant ${usageLine}${text ? `\n${text}` : ""}${toolCalls.length > 0 ? `\ntools=${toolCalls.map((tool) => tool.name).join(", ")}` : ""}`);
    return;
  }

  logger.info(
    `assistant ${usageLine}${text ? ` text="${truncate(text, 160)}"` : ""}${toolCalls.length > 0 ? ` tools=${toolCalls.map((tool) => tool.name).join(", ")}` : ""}`,
  );
}

/**
 * Logs the completion of one tool execution with duration and summary data.
 *
 * @param logger - Destination logger.
 * @param event - Tool-execution completion event.
 * @param startedTools - In-memory tool start timestamps keyed by tool call ID.
 */
function logToolExecutionEnd(logger: Logger, event: Extract<AgentEvent, { type: "tool_execution_end" }>, startedTools: Map<string, number>): void {
  const startedAt = startedTools.get(event.toolCallId);
  startedTools.delete(event.toolCallId);
  const durationMs = startedAt ? Math.max(0, Date.now() - startedAt) : 0;

  logger.info(`tool ${event.toolName} end error=${event.isError ? "yes" : "no"} duration=${durationMs}ms result="${summarizeToolResult(event.result)}"`);
}

/**
 * Logs the end-of-turn cumulative budget snapshot when available.
 *
 * @param logger - Destination logger.
 * @param budgetTracker - Optional run budget tracker.
 */
function logTurnEnd(logger: Logger, budgetTracker: TraceBudgetTracker | undefined): void {
  const totals = budgetTracker?.totals();
  const remaining = budgetTracker?.remaining();

  if (!totals || !remaining) {
    logger.info("turn end");
    return;
  }

  const contextLimitLabel = remaining.contextLimit > 0 ? String(remaining.contextLimit) : "unknown";
  const costCapLabel = remaining.costCapUsd > 0 ? `$${remaining.costCapUsd.toFixed(4)}` : "unbounded";

  logger.info(
    `turn end cumulative in=${totals.inputTokens} out=${totals.outputTokens} contextUsed=${remaining.currentContextTokens}/${contextLimitLabel} costUsed=$${totals.costUsd.toFixed(4)}/${costCapLabel}`,
  );
}

/**
 * Truncates a string to the requested maximum length.
 *
 * @param text - Source text.
 * @param maxLength - Maximum output length.
 * @returns Original or truncated string.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

/**
 * Appends one structured trace record to disk when file tracing is enabled.
 *
 * @param tracePath - Optional destination file path.
 * @param payload - Event payload to serialize.
 * @param logger - Destination logger for write failures.
 */
function appendTrace(tracePath: string | undefined, payload: unknown, logger: Logger): void {
  if (!tracePath) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    fs.appendFileSync(tracePath, `${JSON.stringify({ timestamp: new Date().toISOString(), event: payload })}\n`, "utf8");
  } catch (error) {
    logger.warn(`failed to write trace file ${tracePath}: ${formatError(error)}`);
  }
}

/**
 * Extracts the plain-text content from an assistant message.
 *
 * @param message - Assistant message payload.
 * @returns Concatenated assistant text blocks.
 */
function extractAssistantText(message: AssistantMessageLike): string {
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Checks whether a message has the assistant-specific fields used by the logger.
 *
 * @param message - Candidate agent message.
 * @returns True when the message is an assistant message with usage data.
 */
function isAssistantMessage(message: Extract<AgentEvent, { type: "message_end" }>["message"]): message is AssistantMessageLike {
  return message.role === "assistant" && Array.isArray(message.content) && "usage" in message;
}

/**
 * Produces a compact summary string for one tool result payload.
 *
 * @param result - Raw tool result.
 * @returns Human-readable summary string.
 */
function summarizeToolResult(result: unknown): string {
  if (!result || typeof result !== "object") {
    return truncate(String(result ?? ""), 120);
  }

  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const firstText = content.find(
    (item): item is { type: string; text?: string } => Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text",
  );
  if (typeof firstText?.text === "string" && firstText.text.trim().length > 0) {
    return truncate(firstText.text, 120);
  }

  return truncate(safeStringify(result), 120);
}

/**
 * Serializes an arbitrary value to JSON when possible.
 *
 * @param value - Value to serialize.
 * @returns JSON string or a sentinel when serialization fails.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Formats unknown errors for trace-logger diagnostics.
 *
 * @param error - Unknown thrown value.
 * @returns String form of the error.
 */
function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Assistant-message shape consumed by the trace logger.
 */
type AssistantMessageLike = Extract<Extract<AgentEvent, { type: "message_end" }>["message"], { role: "assistant" }>;
