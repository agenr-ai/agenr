import fs from "node:fs/promises";
import {
  applyMessageTimestampFallbacks,
  extractTimestamp,
  normalizeWhitespace,
  normalizeMessageText,
  normalizeRole,
  parseJsonObjectLine,
  parseJsonlLines,
  resolveTimestampFallback,
} from "./jsonl-base.js";
import type { AdapterParseOptions, SourceAdapter } from "./types.js";
import type { TranscriptMessage } from "../types.js";

interface ToolCallContext {
  name: string;
  args: Record<string, unknown>;
  id?: string;
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
    return getString(args.file_path) ?? getString(args.path) ?? getString(args.file) ?? "(unknown file)";
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

function truncateWithMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n[...truncated]`;
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

function shouldKeepToolResult(toolName: string | undefined, text: string): { keep: boolean; truncateTo?: number } {
  const normalized = (toolName ?? "").trim().toLowerCase();

  // Tool-name rules take precedence over size thresholds.
  const dropToolNames = new Set([
    "read",
    "web_fetch",
    "browser",
    "screenshot",
    "snapshot",
    "canvas",
    "tts",
  ]);
  // Keep "image" tool results (vision-style tools often return text that is knowledge-bearing).
  const keepToolNames = new Set(["web_search", "memory_search", "memory_get", "image"]);

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

  return { keep: false };
}

function extractClaudeTextBlockText(block: Record<string, unknown>): string | undefined {
  if (typeof block.text === "string") {
    const normalized = normalizeWhitespace(block.text);
    return normalized || undefined;
  }
  if (typeof block.content === "string") {
    const normalized = normalizeWhitespace(block.content);
    return normalized || undefined;
  }
  return undefined;
}

function extractToolResultTextAndDropImages(content: unknown): { textParts: string[]; droppedImages: number; droppedNonText: number } {
  if (typeof content === "string") {
    const normalized = normalizeWhitespace(content);
    return { textParts: normalized ? [normalized] : [], droppedImages: 0, droppedNonText: 0 };
  }

  if (!Array.isArray(content)) {
    return { textParts: [], droppedImages: 0, droppedNonText: 0 };
  }

  const out: string[] = [];
  let droppedImages = 0;
  let droppedNonText = 0;

  for (const item of content) {
    const rec = asRecord(item);
    if (!rec) continue;

    const type = typeof rec.type === "string" ? rec.type.trim().toLowerCase() : "";
    if (type === "image") {
      droppedImages += 1;
      continue;
    }

    const text = extractClaudeTextBlockText(rec);
    if (text) {
      out.push(text);
      continue;
    }

    // Some tool results have nested `content` arrays.
    if (Array.isArray(rec.content)) {
      const nested = extractToolResultTextAndDropImages(rec.content);
      droppedImages += nested.droppedImages;
      droppedNonText += nested.droppedNonText;
      out.push(...nested.textParts);
      continue;
    }

    droppedNonText += 1;
  }

  return { textParts: out, droppedImages, droppedNonText };
}

export const claudeCodeAdapter: SourceAdapter = {
  name: "claude-code",

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

    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (typeof parsed.uuid !== "string") {
      return false;
    }
    // Claude Code JSONL can start with progress/system events; use loose detection.
    return (
      type === "user" ||
      type === "assistant" ||
      type === "progress" ||
      type === "system" ||
      type === "file-history-snapshot"
    );
  },

  async parse(filePath: string, options?: AdapterParseOptions) {
    const raw = await fs.readFile(filePath, "utf8");
    const warnings: string[] = [];
    const messages: TranscriptMessage[] = [];

    const filteredMode = options?.raw !== true;
    const verbose = options?.verbose === true;

    const stats = {
      totalRecords: 0,
      dedupedRecords: 0,
      droppedRecordTypes: 0,
      droppedThinkingBlocks: 0,
      droppedToolResultImages: 0,
      droppedEmptyMessages: 0,
      toolResultsKept: 0,
      toolResultsDropped: 0,
      sidechainMessages: 0,
    };

    let sessionId: string | undefined;
    let cwd: string | undefined;
    let model: string | undefined;
    let sessionTimestamp: string | undefined;

    if (!filteredMode) {
      // Raw mode: bypass filtering and truncation as much as possible.
      parseJsonlLines(raw, warnings, (record) => {
        const type = typeof record.type === "string" ? record.type : "";
        const messageRecord = asRecord(record.message);
        const role = normalizeRole(type) ?? normalizeRole(messageRecord?.role);
        if (!role) {
          return;
        }

        const text = normalizeMessageText(messageRecord?.content ?? record.content);
        if (!text) {
          return;
        }

        sessionId = typeof record.sessionId === "string" ? record.sessionId : sessionId;
        cwd = typeof record.cwd === "string" ? record.cwd : cwd;
        model = typeof record.model === "string" ? record.model : model;
        sessionTimestamp = sessionTimestamp ?? extractTimestamp(record);

        messages.push({
          index: messages.length,
          role,
          text,
          timestamp: extractTimestamp(record) ?? (messageRecord ? extractTimestamp(messageRecord) : undefined),
        });
      });

      const fallbackTimestamp =
        messages.length > 0
          ? await applyMessageTimestampFallbacks(filePath, messages, { sessionTimestamp })
          : await resolveTimestampFallback(filePath, sessionTimestamp);

      return {
        messages,
        warnings,
        metadata: {
          platform: "claude-code",
          sessionId,
          cwd,
          model,
          startedAt: sessionTimestamp ?? messages[0]?.timestamp ?? fallbackTimestamp,
        },
      };
    }

    const recordsByUuid = new Map<string, { record: Record<string, unknown>; line: number }>();
    const recordsNoUuid: Array<{ record: Record<string, unknown>; line: number }> = [];

    // First pass: parse and deduplicate streaming messages by uuid (keep last occurrence).
    parseJsonlLines(raw, warnings, (record, lineNumber) => {
      stats.totalRecords += 1;
      const uuid = typeof record.uuid === "string" ? record.uuid : undefined;
      if (uuid) {
        recordsByUuid.set(uuid, { record, line: lineNumber });
      } else {
        recordsNoUuid.push({ record, line: lineNumber });
      }
    });

    const deduped: Array<{ record: Record<string, unknown>; line: number }> = [
      ...Array.from(recordsByUuid.values()),
      ...recordsNoUuid,
    ].sort((a, b) => a.line - b.line);

    stats.dedupedRecords = deduped.length;

    const pendingToolCalls: ToolCallContext[] = [];
    const pendingToolCallsById = new Map<string, ToolCallContext>();

    const resolveToolContext = (toolUseId?: string): ToolCallContext | null => {
      if (toolUseId && pendingToolCallsById.has(toolUseId)) {
        const ctx = pendingToolCallsById.get(toolUseId) ?? null;
        if (ctx) {
          pendingToolCallsById.delete(toolUseId);
          const idx = pendingToolCalls.findIndex((item) => item.id === toolUseId);
          if (idx >= 0) {
            pendingToolCalls.splice(idx, 1);
          }
        }
        return ctx;
      }
      return pendingToolCalls.shift() ?? null;
    };

    const dropRecordTypes = new Set(["progress", "file-history-snapshot", "system"]);

    let lastCwdForPrefix: string | undefined;
    let lastGitBranchForPrefix: string | undefined;

    for (const { record } of deduped) {
      const type = typeof record.type === "string" ? record.type : "";

      if (dropRecordTypes.has(type)) {
        stats.droppedRecordTypes += 1;
        continue;
      }

      const messageRecord = asRecord(record.message);
      const role = normalizeRole(type) ?? normalizeRole(messageRecord?.role);
      if (!role) {
        continue;
      }

      sessionId = typeof record.sessionId === "string" ? record.sessionId : sessionId;
      cwd = typeof record.cwd === "string" ? record.cwd : cwd;
      model = typeof record.model === "string" ? record.model : model;
      sessionTimestamp = sessionTimestamp ?? extractTimestamp(record);

      const gitBranch = typeof record.gitBranch === "string" ? record.gitBranch : undefined;
      const isSidechain = record.isSidechain === true;
      const parentUuid = typeof record.parentUuid === "string" ? record.parentUuid : undefined;

      const timestamp = extractTimestamp(record) ?? (messageRecord ? extractTimestamp(messageRecord) : undefined);

      const content = messageRecord?.content ?? record.content;
      const contentBlocks = Array.isArray(content) ? content : null;

      const textParts: string[] = [];

    const prefixParts: string[] = [];
      if (sessionId) {
        prefixParts.push(`[sessionId: ${sessionId}]`);
      }
      if (cwd && cwd !== lastCwdForPrefix) {
        prefixParts.push(`[cwd: ${cwd}]`);
        lastCwdForPrefix = cwd;
      }
      if (gitBranch && gitBranch !== lastGitBranchForPrefix) {
        prefixParts.push(`[gitBranch: ${gitBranch}]`);
        lastGitBranchForPrefix = gitBranch;
      }

      if (isSidechain) {
        stats.sidechainMessages += 1;
        if (parentUuid) {
          prefixParts.push(`[sidechain parentUuid: ${truncateInline(parentUuid, 80)}]`);
        }
        prefixParts.push("[sidechain]");
      }

      if (!contentBlocks) {
        const text = normalizeWhitespace(normalizeMessageText(content));
        if (text) {
          textParts.push(text);
        }
      } else {
        for (const block of contentBlocks) {
          const rec = asRecord(block);
          if (!rec) continue;

          const blockType = typeof rec.type === "string" ? rec.type.trim().toLowerCase() : "";

          if (blockType === "thinking") {
            stats.droppedThinkingBlocks += 1;
            continue;
          }

          if (blockType === "text") {
            const text = extractClaudeTextBlockText(rec);
            if (text) {
              textParts.push(text);
            }
            continue;
          }

          if (blockType === "tool_use") {
            const calls = extractToolCallBlocks([rec]);
            for (const call of calls) {
              pendingToolCalls.push(call);
              if (call.id) {
                pendingToolCallsById.set(call.id, call);
              }
              textParts.push(summarizeToolCall(call));
            }
            continue;
          }

          if (blockType === "tool_result") {
            const toolUseId =
              getString(rec.tool_use_id) ??
              getString(rec.toolUseId) ??
              getString(rec.tool_call_id) ??
              getString(rec.toolCallId);

            const ctx = resolveToolContext(toolUseId);
            const toolName = getString(rec.name) ?? ctx?.name;
            const args = ctx?.args ?? {};

            const extracted = extractToolResultTextAndDropImages(rec.content);
            stats.droppedToolResultImages += extracted.droppedImages;

            const toolText = normalizeWhitespace(extracted.textParts.join("\n"));
            if (!toolText) {
              continue;
            }

            const decision = shouldKeepToolResult(toolName, toolText);
            if (decision.keep) {
              stats.toolResultsKept += 1;
              const truncated = decision.truncateTo ? truncateWithMarker(toolText, decision.truncateTo) : toolText;
              textParts.push(truncated);
              continue;
            }

            stats.toolResultsDropped += 1;
            textParts.push(toolResultPlaceholder(toolName ?? "unknown", args));
            continue;
          }

          // Unknown blocks: keep any directly-available text, otherwise drop.
          const fallbackText = extractClaudeTextBlockText(rec);
          if (fallbackText) {
            textParts.push(fallbackText);
          }
        }
      }

      if (textParts.length === 0) {
        stats.droppedEmptyMessages += 1;
        continue;
      }

      const combined = normalizeWhitespace([...prefixParts, ...textParts].join("\n"));
      if (!combined) {
        stats.droppedEmptyMessages += 1;
        continue;
      }

      messages.push({
        index: messages.length,
        role,
        text: truncateWithMarker(combined, 5000),
        timestamp,
      });
    }

    const fallbackTimestamp =
      messages.length > 0
        ? await applyMessageTimestampFallbacks(filePath, messages, { sessionTimestamp })
        : await resolveTimestampFallback(filePath, sessionTimestamp);

    if (verbose && filteredMode) {
      warnings.push(
        `Filtered: dropped ${stats.droppedRecordTypes} records by type, ${stats.droppedThinkingBlocks} thinking blocks, ${stats.droppedToolResultImages} tool_result images. Tool results: ${stats.toolResultsDropped} dropped, ${stats.toolResultsKept} kept. Dropped ${stats.droppedEmptyMessages} empty messages. Dedupe: ${stats.totalRecords} records -> ${stats.dedupedRecords} unique.`,
      );
    }

    return {
      messages,
      warnings,
      metadata: {
        platform: "claude-code",
        sessionId,
        cwd,
        model,
        startedAt: sessionTimestamp ?? messages[0]?.timestamp ?? fallbackTimestamp,
      },
    };
  },
};
