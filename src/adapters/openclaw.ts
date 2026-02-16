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
import type { SourceAdapter } from "./types.js";
import type { TranscriptMessage } from "../types.js";

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

  async parse(filePath: string) {
    const raw = await fs.readFile(filePath, "utf8");
    const warnings: string[] = [];
    const messages: TranscriptMessage[] = [];

    let sessionId: string | undefined;
    let cwd: string | undefined;
    let model: string | undefined;
    let sessionTimestamp: string | undefined;

    parseJsonlLines(raw, warnings, (record) => {
      if (record.type === "session") {
        sessionId = typeof record.id === "string" ? record.id : sessionId;
        cwd = typeof record.cwd === "string" ? record.cwd : cwd;
        model = typeof record.model === "string" ? record.model : model;
        sessionTimestamp = extractTimestamp(record) ?? sessionTimestamp;
        return;
      }

      if (record.type !== "message" || !record.message || typeof record.message !== "object") {
        return;
      }

      const message = record.message as Record<string, unknown>;
      const role = normalizeRole(message.role);
      if (!role) {
        return;
      }

      const text = normalizeMessageText(message.content);
      if (!text) {
        return;
      }

      messages.push({
        index: messages.length,
        role,
        text,
        timestamp: extractTimestamp(record) ?? extractTimestamp(message),
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
        platform: "openclaw",
        sessionId,
        cwd,
        model,
        startedAt: sessionTimestamp ?? messages[0]?.timestamp ?? fallbackTimestamp,
      },
    };
  },
};
