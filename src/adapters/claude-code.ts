import fs from "node:fs/promises";
import {
  applyMessageTimestampFallbacks,
  extractTimestamp,
  normalizeMessageText,
  normalizeRole,
  parseJsonObjectLine,
  parseJsonlLines,
  resolveTimestampFallback,
} from "./jsonl-base.js";
import type { AdapterParseOptions, SourceAdapter } from "./types.js";
import type { TranscriptMessage } from "../types.js";

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
    return (type === "user" || type === "assistant") && typeof parsed.uuid === "string";
  },

  async parse(filePath: string, _options?: AdapterParseOptions) {
    const raw = await fs.readFile(filePath, "utf8");
    const warnings: string[] = [];
    const messages: TranscriptMessage[] = [];

    let sessionId: string | undefined;
    let cwd: string | undefined;
    let model: string | undefined;
    let sessionTimestamp: string | undefined;

    parseJsonlLines(raw, warnings, (record) => {
      const type = typeof record.type === "string" ? record.type : "";
      if (type === "file-history-snapshot") {
        return;
      }

      const messageRecord =
        record.message && typeof record.message === "object" ? (record.message as Record<string, unknown>) : null;
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
  },
};
