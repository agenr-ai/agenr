import fs from "node:fs";
import path from "node:path";

import type { AgentEvent } from "@mariozechner/pi-agent-core";

import type { SurgeonRunAction } from "../../core/surgeon/domain/action-types.js";
import { createLogger, type Logger } from "../../logger.js";

/**
 * Minimal budget snapshot contract consumed by the trace logger.
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

const TRACE_MAX_STRING_LENGTH = 320;
const TRACE_MAX_ARRAY_ITEMS = 12;
const TRACE_MAX_OBJECT_KEYS = 20;

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
        switch (event.type) {
          case "agent_start":
            appendTrace(options.tracePath, { kind: "agent_start" }, logger);
            return;

          case "turn_start":
            appendTrace(options.tracePath, { kind: "turn_start" }, logger);
            logger.info("surgeon turn started");
            return;

          case "message_end":
            appendTrace(options.tracePath, buildMessageTraceRecord(event), logger);

            if (event.message.role !== "assistant") {
              return;
            }
            logAssistantMessage(logger, event, options.verbose);
            return;

          case "tool_execution_start":
            startedTools.set(event.toolCallId, Date.now());
            appendTrace(
              options.tracePath,
              {
                kind: "tool_start",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: sanitizeTraceValue(event.args),
              },
              logger,
            );
            logger.info(options.verbose ? `tool ${event.toolName} start args=${safeStringify(event.args)}` : `tool ${event.toolName} start`);
            return;

          case "tool_execution_end": {
            const durationMs = consumeToolDurationMs(startedTools, event.toolCallId);
            appendTrace(options.tracePath, buildToolExecutionEndTraceRecord(event, durationMs), logger);
            logToolExecutionEnd(logger, event, durationMs);
            return;
          }

          case "turn_end":
            appendTrace(options.tracePath, buildTurnSummaryTraceRecord(options.budgetTracker), logger);
            logTurnEnd(logger, options.budgetTracker);
            return;

          case "agent_end":
            appendTrace(
              options.tracePath,
              {
                kind: "agent_end",
                messageCount: event.messages.length,
              },
              logger,
            );
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
            kind: "surgeon_action",
            actionType: action.actionType,
            entryIds: action.entryIds,
            reasoning: truncate(action.reasoning.trim(), TRACE_MAX_STRING_LENGTH),
            details: sanitizeTraceValue(action.details),
            recallDelta: sanitizeTraceValue(action.recallDelta),
            createdAt: action.createdAt,
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
 * @param durationMs - Measured execution duration in milliseconds.
 */
function logToolExecutionEnd(logger: Logger, event: Extract<AgentEvent, { type: "tool_execution_end" }>, durationMs: number): void {
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
 * Builds one compact trace record for a completed message.
 *
 * User messages preserve the prompt text. Assistant messages preserve the
 * text, tool calls, and usage that explain the model's decisions. Streaming
 * updates and tool-result echo messages are intentionally excluded.
 *
 * @param event - Completed message event.
 * @returns Compact trace record, or null when the message is not useful in file traces.
 */
function buildMessageTraceRecord(event: Extract<AgentEvent, { type: "message_end" }>): Record<string, unknown> | null {
  if (event.message.role === "user") {
    return {
      kind: "user_message",
      text: extractUserText(event.message.content),
    };
  }

  if (!isAssistantMessage(event.message)) {
    return null;
  }

  const toolCalls = event.message.content
    .filter((block): block is Extract<(typeof event.message.content)[number], { type: "toolCall" }> => block.type === "toolCall")
    .map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      args: sanitizeTraceValue(toolCall.arguments),
    }));

  return {
    kind: "assistant_message",
    text: extractAssistantText(event.message),
    toolCalls,
    usage: {
      input: event.message.usage.input,
      output: event.message.usage.output,
      totalTokens: event.message.usage.totalTokens,
      costUsd: Number(event.message.usage.cost.total.toFixed(6)),
    },
    stopReason: event.message.stopReason,
  };
}

/**
 * Builds one compact trace record for a completed tool execution.
 *
 * @param event - Tool completion event.
 * @param durationMs - Measured execution duration in milliseconds.
 * @returns Compact trace record.
 */
function buildToolExecutionEndTraceRecord(event: Extract<AgentEvent, { type: "tool_execution_end" }>, durationMs: number): Record<string, unknown> {
  return {
    kind: "tool_end",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    durationMs,
    isError: event.isError,
    summary: summarizeToolResult(event.result),
    result: summarizeTraceToolResult(event.result),
  };
}

/**
 * Builds one compact trace record for end-of-turn budget state.
 *
 * @param budgetTracker - Optional run budget tracker.
 * @returns Compact trace record.
 */
function buildTurnSummaryTraceRecord(budgetTracker: TraceBudgetTracker | undefined): Record<string, unknown> {
  const totals = budgetTracker?.totals();
  const remaining = budgetTracker?.remaining();

  if (!totals || !remaining) {
    return { kind: "turn_summary" };
  }

  return {
    kind: "turn_summary",
    totals: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costUsd: Number(totals.costUsd.toFixed(6)),
    },
    context: {
      usedTokens: remaining.currentContextTokens,
      limitTokens: remaining.contextLimit > 0 ? remaining.contextLimit : null,
      remainingTokens: remaining.remainingContextTokens,
    },
    cost: {
      capUsd: remaining.costCapUsd > 0 ? Number(remaining.costCapUsd.toFixed(6)) : null,
      remainingUsd: Number(remaining.remainingCostUsd.toFixed(6)),
    },
  };
}

/**
 * Consumes the tracked start time for one tool call and returns its duration.
 *
 * @param startedTools - Tool start timestamps keyed by tool call ID.
 * @param toolCallId - Tool call to resolve.
 * @returns Elapsed milliseconds, or `0` when the start is unavailable.
 */
function consumeToolDurationMs(startedTools: Map<string, number>, toolCallId: string): number {
  const startedAt = startedTools.get(toolCallId);
  startedTools.delete(toolCallId);
  return startedAt ? Math.max(0, Date.now() - startedAt) : 0;
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
 * @param payload - Compact trace payload to serialize.
 * @param logger - Destination logger for write failures.
 */
function appendTrace(tracePath: string | undefined, payload: Record<string, unknown> | null, logger: Logger): void {
  if (!tracePath || !payload) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    fs.appendFileSync(tracePath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...payload })}\n`, "utf8");
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
 * Extracts readable user text from a user message payload.
 *
 * @param content - Raw user-message content.
 * @returns Human-readable user text.
 */
function extractUserText(content: Extract<AgentEvent, { type: "message_end" }>["message"]["content"]): string {
  if (typeof content === "string") {
    return truncate(content.trim(), TRACE_MAX_STRING_LENGTH);
  }

  return truncate(
    content
      .filter((block): block is Extract<(typeof content)[number], { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim(),
    TRACE_MAX_STRING_LENGTH,
  );
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
  if (typeof result === "string") {
    return truncate(result, 200);
  }

  return truncate(safeStringify(result), 200);
}

/**
 * Summarizes a tool result for compact file tracing.
 *
 * Structured tool results prefer `details` over the duplicated rendered text.
 *
 * @param result - Raw tool result.
 * @returns Signal-rich tool result payload with large blobs removed.
 */
function summarizeTraceToolResult(result: unknown): unknown {
  if (isToolResultWithDetails(result)) {
    return sanitizeTraceValue(result.details);
  }

  return sanitizeTraceValue(result);
}

/**
 * Detects the repo-standard tool-result wrapper.
 *
 * @param value - Candidate tool result payload.
 * @returns True when the payload exposes a structured `details` field.
 */
function isToolResultWithDetails(value: unknown): value is { details: unknown } {
  return typeof value === "object" && value !== null && "details" in value;
}

/**
 * Compacts arbitrary trace values so the JSONL file stays readable.
 *
 * Strings are truncated, embeddings are replaced with size markers, long
 * arrays are trimmed, and large objects are capped to the most relevant keys.
 *
 * @param value - Arbitrary trace value.
 * @returns Compact trace-safe value.
 */
function sanitizeTraceValue(value: unknown): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return truncate(value, TRACE_MAX_STRING_LENGTH);
  }

  if (Array.isArray(value)) {
    if (value.length > TRACE_MAX_ARRAY_ITEMS && value.every((item) => typeof item === "number")) {
      return {
        omitted: "numeric_array",
        length: value.length,
      };
    }

    if (value.length <= TRACE_MAX_ARRAY_ITEMS) {
      return value.map((item) => sanitizeTraceValue(item));
    }

    return {
      items: value.slice(0, TRACE_MAX_ARRAY_ITEMS).map((item) => sanitizeTraceValue(item)),
      totalCount: value.length,
      truncatedCount: value.length - TRACE_MAX_ARRAY_ITEMS,
    };
  }

  const entries = Object.entries(value);
  const compactEntries = entries.slice(0, TRACE_MAX_OBJECT_KEYS).map(([key, entryValue]) => {
    if ((key === "embedding" || key === "embeddings") && Array.isArray(entryValue)) {
      return [
        key,
        {
          omitted: "embedding",
          dimensions: entryValue.length,
        },
      ] as const;
    }

    return [key, sanitizeTraceValue(entryValue)] as const;
  });

  return {
    ...Object.fromEntries(compactEntries),
    ...(entries.length > TRACE_MAX_OBJECT_KEYS ? { truncatedKeyCount: entries.length - TRACE_MAX_OBJECT_KEYS } : {}),
  };
}

/**
 * Safely serializes an arbitrary value for logs.
 *
 * @param value - Arbitrary value to serialize.
 * @returns Stable string representation.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Normalizes unknown logger errors into a readable string.
 *
 * @param error - Unknown thrown value.
 * @returns Human-readable error message.
 */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Assistant-message subset used by the trace logger. */
type AssistantMessageLike = Extract<Extract<AgentEvent, { type: "message_end" }>["message"], { role: "assistant" }>;
