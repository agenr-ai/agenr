import fs from "node:fs/promises";
import {
  applyMessageTimestampFallbacks,
  extractTimestamp,
  normalizeWhitespace,
  normalizeMessageText,
  parseJsonObjectLine,
  parseJsonlLines,
  resolveTimestampFallback,
} from "./jsonl-base.js";
import type { AdapterParseOptions, SourceAdapter } from "./types.js";
import type { TranscriptMessage } from "../types.js";

type OpenClawRole = "user" | "assistant" | "toolResult" | "system" | "unknown";

interface ToolCallContext {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

function normalizeOpenClawRole(value: unknown): OpenClawRole {
  if (typeof value !== "string") {
    return "unknown";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "user" || normalized === "human") return "user";
  if (normalized === "assistant" || normalized === "ai" || normalized === "developer") return "assistant";
  if (normalized === "system") return "system";
  if (normalized === "tool" || normalized === "toolresult" || normalized === "tool_result") return "toolResult";
  return "unknown";
}

function truncateWithMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n[...truncated]`;
}

function isPureBase64(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 500) {
    return false;
  }
  // Avoid false positives on long plain text by requiring at least one base64 marker char.
  if (!/[+/=]/.test(trimmed)) {
    return false;
  }
  return /^[A-Za-z0-9+/=\s]{500,}$/.test(trimmed);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function truncateInline(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function firstStringArgValue(args: Record<string, unknown>, max: number): string | undefined {
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.trim().length > 0) {
      return truncateInline(value.trim(), max);
    }
  }
  return undefined;
}

function toolIdentifier(toolName: string, args: Record<string, unknown>): string {
  const lower = toolName.trim().toLowerCase();

  if (lower === "read" || lower === "edit" || lower === "write") {
    return (
      getString(args.file_path) ??
      getString(args.path) ??
      getString(args.file) ??
      "(unknown file)"
    );
  }

  if (lower === "exec") {
    const cmd = getString(args.command) ?? getString(args.cmd) ?? "(unknown command)";
    return truncateInline(cmd, 100);
  }

  if (lower === "web_fetch") {
    return getString(args.url) ?? "(unknown url)";
  }

  if (lower === "web_search") {
    return getString(args.query) ?? "(unknown query)";
  }

  if (lower === "browser") {
    const action = getString(args.action) ?? "(unknown action)";
    const targetUrl = getString(args.targetUrl) ?? getString(args.url);
    return targetUrl ? `${action} ${targetUrl}` : action;
  }

  if (lower === "image") {
    return getString(args.image) ?? getString(args.url) ?? getString(args.path) ?? "(unknown image)";
  }

  if (lower === "canvas") {
    return getString(args.action) ?? "(unknown action)";
  }

  if (lower === "tts") {
    const text = getString(args.text) ?? "(unknown text)";
    return truncateInline(text, 50);
  }

  return firstStringArgValue(args, 80) ?? "(unknown)";
}

function toolResultPlaceholder(toolName: string, args: Record<string, unknown>): string {
  const name = toolName.trim().length > 0 ? toolName.trim() : "unknown";
  const identifier = toolIdentifier(name, args);
  return `[tool result from ${name}: ${identifier} - filtered]`;
}

function extractToolCallBlocks(content: unknown): ToolCallContext[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const calls: ToolCallContext[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) continue;

    const type = typeof rec.type === "string" ? rec.type.trim().toLowerCase() : "";
    const name = getString(rec.name) ?? getString(rec.tool) ?? getString(rec.tool_name);
    const args = asRecord(rec.arguments) ?? asRecord(rec.args) ?? asRecord(rec.input) ?? {};
    const id = getString(rec.id) ?? getString(rec.toolCallId) ?? getString(rec.tool_call_id) ?? getString(rec.call_id);

    if ((type === "toolcall" || type === "tool_call" || type === "tool_use" || type === "tooluse") && name) {
      calls.push({ name, args, id });
      continue;
    }

    // Some logs omit block.type but include name + arguments.
    if (!type && name && ("arguments" in rec || "args" in rec || "input" in rec)) {
      calls.push({ name, args, id });
    }
  }

  return calls;
}

function extractAssistantTextParts(content: unknown): string[] {
  if (typeof content === "string") {
    const normalized = normalizeWhitespace(content);
    return normalized ? [normalized] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const out: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) continue;

    if (typeof rec.text === "string") {
      const normalized = normalizeWhitespace(rec.text);
      if (normalized) out.push(normalized);
      continue;
    }

    const type = typeof rec.type === "string" ? rec.type.trim().toLowerCase() : "";
    if (
      typeof rec.content === "string" &&
      (type === "input_text" || type === "output_text" || type === "text")
    ) {
      const normalized = normalizeWhitespace(rec.content);
      if (normalized) out.push(normalized);
    }
  }

  return out;
}

function summarizeToolCall(call: ToolCallContext): string {
  const name = call.name;
  const lower = name.trim().toLowerCase();
  const args = call.args;

  const filePath = getString(args.file_path) ?? getString(args.path) ?? getString(args.file);
  if (lower === "read") {
    return `[called Read: ${filePath ?? "(unknown file)"}]`;
  }
  if (lower === "write") {
    const content = getString(args.content) ?? getString(args.text) ?? "";
    return `[called Write: ${filePath ?? "(unknown file)"} - ${content.length} chars]`;
  }
  if (lower === "edit") {
    const oldText = getString(args.oldText) ?? getString(args.old_string) ?? "";
    return `[called Edit: ${filePath ?? "(unknown file)"} - replaced ${oldText.length} chars]`;
  }
  if (lower === "exec") {
    const cmd = getString(args.command) ?? getString(args.cmd) ?? "(unknown command)";
    return `[called exec: ${truncateInline(cmd, 200)}]`;
  }
  if (lower === "web_search") {
    const query = getString(args.query) ?? "(unknown query)";
    return `[called web_search: ${truncateInline(query, 200)}]`;
  }
  if (lower === "web_fetch") {
    const url = getString(args.url) ?? "(unknown url)";
    return `[called web_fetch: ${truncateInline(url, 200)}]`;
  }
  if (lower === "browser") {
    const action = getString(args.action) ?? "(unknown action)";
    return `[called browser: ${truncateInline(action, 200)}]`;
  }
  if (lower === "message") {
    const action = getString(args.action) ?? "(unknown action)";
    const target = getString(args.target) ?? getString(args.to) ?? "(unknown target)";
    return `[called message: ${truncateInline(action, 200)} to ${truncateInline(target, 200)}]`;
  }

  const relevant =
    firstStringArgValue(
      Object.fromEntries(
        Object.entries(args).filter(
          ([key]) =>
            ![
              "content",
              "oldText",
              "old_string",
              "newText",
              "new_string",
              "buffer",
              "data",
            ].includes(key) && !(lower === "write" && key === "text"),
        ),
      ),
      80,
    ) ?? "(no args)";

  return `[called ${name}: ${relevant}]`;
}

export const openClawAdapter: SourceAdapter = {
  name: "openclaw",

  canHandle(filePath: string, firstLine?: string): boolean {
    if (!filePath.toLowerCase().endsWith(".jsonl")) {
      return false;
    }

    if (!firstLine) {
      return false;
    }

    const parsed = parseJsonObjectLine(firstLine);
    if (!parsed) {
      return false;
    }

    return parsed.type === "session";
  },

  async parse(filePath: string, options?: AdapterParseOptions) {
    const raw = await fs.readFile(filePath, "utf8");
    const warnings: string[] = [];
    const messages: TranscriptMessage[] = [];

    const filteredMode = options?.raw !== true;
    const verbose = options?.verbose === true;

    const stats = {
      totalMessageRecords: 0,
      systemDropped: 0,
      base64Dropped: 0,
      skippedRecordTypes: 0,
      toolResultsKept: 0,
      toolResultsDropped: 0,
    };

    let sessionId: string | undefined;
    let cwd: string | undefined;
    let model: string | undefined;
    let sessionTimestamp: string | undefined;

    const pendingToolCalls: ToolCallContext[] = [];
    const pendingToolCallsById = new Map<string, ToolCallContext>();

    const skipRecordTypes = new Set(["compaction", "custom", "model_change", "thinking_level_change"]);
    const dropToolNames = new Set([
      "read",
      "web_fetch",
      "browser",
      "screenshot",
      "snapshot",
      "image",
      "canvas",
      "tts",
    ]);
    const keepToolNames = new Set([
      "web_search",
      "memory_search",
      "memory_get",
    ]);

    const resolveToolContext = (message: Record<string, unknown>): ToolCallContext | null => {
      const id =
        getString(message.toolCallId) ??
        getString(message.tool_call_id) ??
        getString(message.call_id) ??
        getString(message.id);
      if (id && pendingToolCallsById.has(id)) {
        const ctx = pendingToolCallsById.get(id) ?? null;
        if (ctx) {
          pendingToolCallsById.delete(id);
          const idx = pendingToolCalls.findIndex((item) => item.id === id);
          if (idx >= 0) {
            pendingToolCalls.splice(idx, 1);
          }
        }
        return ctx;
      }

      return pendingToolCalls.shift() ?? null;
    };

    const shouldKeepToolResult = (toolName: string | undefined, text: string): { keep: boolean; truncateTo?: number } => {
      const normalized = (toolName ?? "").trim().toLowerCase();

      if (normalized && dropToolNames.has(normalized)) {
        return { keep: false };
      }

      if (normalized && keepToolNames.has(normalized)) {
        return { keep: true, truncateTo: 2000 };
      }

      if (normalized === "exec") {
        if (text.length < 1000) {
          return { keep: true, truncateTo: 2000 };
        }
        if (/(error|failed|fail)/.test(text) || /(ERROR|FAIL)/.test(text)) {
          return { keep: true, truncateTo: 2000 };
        }
        return { keep: false };
      }

      // Unknown/unlisted tools: fallback based on size only.
      if (text.length < 500) {
        return { keep: true, truncateTo: 2000 };
      }

      // Any unlisted tool result over 2000 chars is treated as too large to keep,
      // but the 500-char keep fallback is the primary size gate.
      return { keep: false };
    };

    parseJsonlLines(raw, warnings, (record) => {
      if (record.type === "session") {
        sessionId = typeof record.id === "string" ? record.id : sessionId;
        cwd = typeof record.cwd === "string" ? record.cwd : cwd;
        model = typeof record.model === "string" ? record.model : model;
        sessionTimestamp = extractTimestamp(record) ?? sessionTimestamp;
        return;
      }

      if (typeof record.type === "string" && skipRecordTypes.has(record.type)) {
        stats.skippedRecordTypes += 1;
        return;
      }

      if (!record.message || typeof record.message !== "object") {
        return;
      }

      stats.totalMessageRecords += 1;

      const message = record.message as Record<string, unknown>;
      const role = normalizeOpenClawRole(message.role);

      if (role === "system") {
        stats.systemDropped += 1;
        return;
      }

      const timestamp = extractTimestamp(record) ?? extractTimestamp(message);

      if (role === "user") {
        const text = normalizeMessageText(message.content);
        if (!text) {
          return;
        }
        if (isPureBase64(text)) {
          stats.base64Dropped += 1;
          return;
        }
        messages.push({
          index: messages.length,
          role: "user",
          text,
          timestamp,
        });
        return;
      }

      if (role === "assistant") {
        const content = message.content;

        const toolCalls = extractToolCallBlocks(content);
        for (const call of toolCalls) {
          pendingToolCalls.push(call);
          if (call.id) {
            pendingToolCallsById.set(call.id, call);
          }
        }

        let text: string;
        if (!filteredMode) {
          text = normalizeMessageText(content);
        } else {
          const textParts = extractAssistantTextParts(content);
          const summaries = toolCalls.map((call) => summarizeToolCall(call));
          text = normalizeWhitespace([...textParts, ...summaries].join("\n"));
        }

        if (!text) {
          return;
        }
        if (isPureBase64(text)) {
          stats.base64Dropped += 1;
          return;
        }
        if (filteredMode) {
          text = truncateWithMarker(text, 5000);
        }

        messages.push({
          index: messages.length,
          role: "assistant",
          text,
          timestamp,
        });
        return;
      }

      if (role === "toolResult") {
        const content = message.content;
        const toolText = normalizeMessageText(content);
        if (!toolText) {
          return;
        }
        if (isPureBase64(toolText)) {
          stats.base64Dropped += 1;
          return;
        }

        if (!filteredMode) {
          messages.push({
            index: messages.length,
            role: "assistant",
            text: toolText,
            timestamp,
          });
          return;
        }

        const directToolName =
          getString(message.name) ??
          getString(message.tool) ??
          getString(record.name) ??
          getString(record.tool);
        const ctx = resolveToolContext(message);
        const toolName = directToolName ?? ctx?.name;
        const args = ctx?.args ?? {};

        const decision = shouldKeepToolResult(toolName, toolText);
        if (decision.keep) {
          stats.toolResultsKept += 1;
          const truncated = decision.truncateTo ? truncateWithMarker(toolText, decision.truncateTo) : toolText;
          messages.push({
            index: messages.length,
            role: "assistant",
            text: truncated,
            timestamp,
          });
          return;
        }

        stats.toolResultsDropped += 1;
        messages.push({
          index: messages.length,
          role: "assistant",
          text: toolResultPlaceholder(toolName ?? "unknown", args),
          timestamp,
        });
      }
    });

    const fallbackTimestamp =
      messages.length > 0
        ? await applyMessageTimestampFallbacks(filePath, messages, { sessionTimestamp })
        : await resolveTimestampFallback(filePath, sessionTimestamp);

    if (verbose && filteredMode) {
      warnings.push(
        `Filtered: ${stats.toolResultsDropped} toolResults dropped, ${stats.toolResultsKept} kept. ${stats.systemDropped} system dropped. ${messages.length}/${stats.totalMessageRecords} messages passed to chunker.`,
      );
    }

    return {
      messages,
      warnings,
      metadata: {
        platform: "openclaw",
        sessionId,
        cwd,
        model,
        startedAt: sessionTimestamp ?? messages[0]?.timestamp ?? fallbackTimestamp,
      },
    };
  },
};
