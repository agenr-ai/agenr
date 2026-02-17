import fs from "node:fs/promises";
import {
  applyMessageTimestampFallbacks,
  extractTimestamp,
  normalizeMessageText,
  parseJsonObjectLine,
  parseJsonlLines,
  resolveTimestampFallback,
} from "./jsonl-base.js";
import type { AdapterParseOptions, SourceAdapter } from "./types.js";
import type { TranscriptMessage } from "../types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function truncateWithMarker(text: string, maxChars: number, marker = "[...truncated]"): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n${marker}`;
}

function truncateInline(text: string, maxChars: number, marker = "[...truncated]"): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)} ${marker}`;
}

function hasErrorLikeText(text: string): boolean {
  return /(error|failed|fail)/.test(text) || /(ERROR|FAIL)/.test(text);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function extractExecCommand(args: Record<string, unknown>): string | undefined {
  return getString(args.cmd) ?? getString(args.command);
}

interface PendingFunctionCall {
  name: string;
  argsRaw?: string;
  commandPreview?: string;
}

function looksLikeCodexSessionMeta(record: Record<string, unknown>): boolean {
  if (record.type !== "session_meta") {
    return false;
  }

  if (record.originator === "codex_cli_rs") {
    return true;
  }

  if (!record.payload || typeof record.payload !== "object") {
    return false;
  }

  const payload = record.payload as Record<string, unknown>;
  if (payload.originator === "codex_cli_rs") {
    return true;
  }

  return typeof payload.id === "string" && ("cwd" in payload || "model_provider" in payload || "cli_version" in payload);
}

export const codexAdapter: SourceAdapter = {
  name: "codex",

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

    return looksLikeCodexSessionMeta(parsed);
  },

  async parse(filePath: string, options?: AdapterParseOptions) {
    const raw = await fs.readFile(filePath, "utf8");
    const warnings: string[] = [];
    const messages: TranscriptMessage[] = [];

    const filteredMode = options?.raw !== true;

    let sessionId: string | undefined;
    let cwd: string | undefined;
    let model: string | undefined;
    let sessionTimestamp: string | undefined;

    let sawTurnContext = false;
    let sawEventConversationMessages = false;
    const pendingFunctionCalls = new Map<string, PendingFunctionCall>();

    parseJsonlLines(raw, warnings, (record) => {
      if (looksLikeCodexSessionMeta(record)) {
        const payload = record.payload && typeof record.payload === "object" ? (record.payload as Record<string, unknown>) : null;
        sessionId = payload && typeof payload.id === "string" ? payload.id : sessionId;
        cwd = payload && typeof payload.cwd === "string" ? payload.cwd : cwd;
        model =
          payload && typeof payload.model === "string"
            ? payload.model
            : payload && typeof payload.model_provider === "string"
              ? payload.model_provider
              : model;
        sessionTimestamp = extractTimestamp(record) ?? (payload ? extractTimestamp(payload) : undefined) ?? sessionTimestamp;
        return;
      }

      const recordType = typeof record.type === "string" ? record.type : "";

      if (recordType === "turn_context") {
        const payload = asRecord(record.payload);
        if (!payload) {
          return;
        }

        if (filteredMode) {
          if (!sawTurnContext) {
            sawTurnContext = true;
            cwd = getString(payload.cwd) ?? cwd;
            model = getString(payload.model) ?? model;
          }
          return;
        }

        messages.push({
          index: messages.length,
          role: "assistant",
          text: JSON.stringify(payload),
          timestamp: extractTimestamp(record) ?? extractTimestamp(payload),
        });
        return;
      }

      const payload = asRecord(record.payload);
      const payloadType = getString(payload?.type) ?? "";

      if (filteredMode) {
        if (payloadType === "reasoning" || payloadType === "token_count") {
          return;
        }
        if (payloadType === "task_started" || payloadType === "task_complete" || payloadType === "turn_aborted") {
          return;
        }
      }

      if (recordType === "event_msg" && payload) {
        if (payloadType === "user_message") {
          const text = getString(payload.message);
          if (!text) return;
          sawEventConversationMessages = true;
          messages.push({
            index: messages.length,
            role: "user",
            text,
            timestamp: extractTimestamp(record) ?? extractTimestamp(payload),
          });
          return;
        }

        if (payloadType === "agent_message") {
          const text = getString(payload.message);
          if (!text) return;
          sawEventConversationMessages = true;
          const output = filteredMode ? truncateWithMarker(text, 8000) : text;
          messages.push({
            index: messages.length,
            role: "assistant",
            text: output,
            timestamp: extractTimestamp(record) ?? extractTimestamp(payload),
          });
          return;
        }

        if (payloadType === "agent_reasoning") {
          const text = getString(payload.text);
          if (!text) return;
          messages.push({
            index: messages.length,
            role: "assistant",
            text,
            timestamp: extractTimestamp(record) ?? extractTimestamp(payload),
          });
          return;
        }

        if (!filteredMode) {
          messages.push({
            index: messages.length,
            role: "assistant",
            text: JSON.stringify(payload),
            timestamp: extractTimestamp(record) ?? extractTimestamp(payload),
          });
        }
        return;
      }

      if (recordType !== "response_item" || !payload) {
        if (!filteredMode && payload) {
          messages.push({
            index: messages.length,
            role: "assistant",
            text: JSON.stringify(payload),
            timestamp: extractTimestamp(record) ?? extractTimestamp(payload),
          });
        }
        return;
      }

      if (payloadType === "message") {
        const role = getString(payload.role)?.toLowerCase();
        const timestamp = extractTimestamp(record) ?? extractTimestamp(payload);

        // Filter sandbox/system "developer" role messages entirely.
        if (filteredMode && role === "developer") {
          return;
        }

        // Codex writes both event_msg user_message/agent_message and response_item message
        // records. The response_item messages frequently include injected instructions and
        // are duplicated. In filtered mode we rely on event_msg records for conversation text.
        if (filteredMode) return;

        const normalizedRole = role === "user" ? "user" : "assistant";
        const text = normalizeMessageText(payload.content);
        if (!text) return;
        messages.push({
          index: messages.length,
          role: normalizedRole,
          text,
          timestamp,
        });
        return;
      }

      if (payloadType === "function_call") {
        const name = getString(payload.name) ?? "unknown";
        const argsRaw = getString(payload.arguments);
        const callId = getString(payload.call_id);

        let cmdPreview: string | undefined;
        if (argsRaw) {
          const argsParsed = parseJsonObject(argsRaw);
          const cmd = argsParsed ? extractExecCommand(argsParsed) : undefined;
          cmdPreview = cmd ? cmd.slice(0, 100) : argsRaw.slice(0, 100);
        }

        if (callId) {
          pendingFunctionCalls.set(callId, { name, argsRaw, commandPreview: cmdPreview });
        }

        const argsText = argsRaw ? (filteredMode ? truncateInline(argsRaw, 200) : argsRaw) : "(no args)";
        messages.push({
          index: messages.length,
          role: "assistant",
          text: `[function_call ${name}: ${argsText}]`,
          timestamp: extractTimestamp(record) ?? extractTimestamp(payload),
        });
        return;
      }

      if (payloadType === "function_call_output") {
        const output = getString(payload.output) ?? "";
        if (!output) return;

        const callId = getString(payload.call_id);
        const ctx = callId ? pendingFunctionCalls.get(callId) : undefined;
        if (callId) {
          pendingFunctionCalls.delete(callId);
        }

        if (!filteredMode) {
          messages.push({
            index: messages.length,
            role: "assistant",
            text: output,
            timestamp: extractTimestamp(record) ?? extractTimestamp(payload),
          });
          return;
        }

        if (output.length <= 1000) {
          messages.push({
            index: messages.length,
            role: "assistant",
            text: output,
            timestamp: extractTimestamp(record) ?? extractTimestamp(payload),
          });
          return;
        }

        if (hasErrorLikeText(output)) {
          messages.push({
            index: messages.length,
            role: "assistant",
            text: truncateWithMarker(output, 2000),
            timestamp: extractTimestamp(record) ?? extractTimestamp(payload),
          });
          return;
        }

        if (output.length > 2000) {
          const name = ctx?.name ?? "unknown";
          const preview = ctx?.commandPreview ?? "";
          const previewPart = preview ? `: ${preview}` : "";
          messages.push({
            index: messages.length,
            role: "assistant",
            text: `[function output from ${name}${previewPart} - filtered (${output.length} chars)]`,
            timestamp: extractTimestamp(record) ?? extractTimestamp(payload),
          });
          return;
        }

        messages.push({
          index: messages.length,
          role: "assistant",
          text: output,
          timestamp: extractTimestamp(record) ?? extractTimestamp(payload),
        });
        return;
      }

      if (payloadType === "custom_tool_call") {
        const name = getString(payload.name) ?? "unknown";
        const input = getString(payload.input) ?? "";
        const timestamp = extractTimestamp(record) ?? extractTimestamp(payload);

        const text = filteredMode
          ? input.length > 10_000
            ? `${input.slice(0, 10_000)}\n[patch truncated, ${input.length} total chars]`
            : input
          : input;

        if (!text) return;

        messages.push({
          index: messages.length,
          role: "assistant",
          text: name === "apply_patch" ? text : `[custom_tool_call ${name}]\n${text}`,
          timestamp,
        });
        return;
      }

      if (payloadType === "custom_tool_call_output") {
        const output = getString(payload.output) ?? "";
        if (!output) return;
        messages.push({
          index: messages.length,
          role: "assistant",
          text: output,
          timestamp: extractTimestamp(record) ?? extractTimestamp(payload),
        });
        return;
      }

      if (!filteredMode) {
        messages.push({
          index: messages.length,
          role: "assistant",
          text: JSON.stringify(payload),
          timestamp: extractTimestamp(record) ?? extractTimestamp(payload),
        });
      }
    });

    const fallbackTimestamp =
      messages.length > 0
        ? await applyMessageTimestampFallbacks(filePath, messages, { sessionTimestamp })
        : await resolveTimestampFallback(filePath, sessionTimestamp);

    return {
      messages,
      warnings,
      metadata: {
        platform: "codex",
        sessionId,
        cwd,
        model,
        startedAt: sessionTimestamp ?? messages[0]?.timestamp ?? fallbackTimestamp,
      },
    };
  },
};
