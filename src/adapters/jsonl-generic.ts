import fs from "node:fs/promises";
import {
  applyMessageTimestampFallbacks,
  extractGenericMessageCandidate,
  extractTimestamp,
  normalizeMessageText,
  parseJsonlLines,
  resolveTimestampFallback,
} from "./jsonl-base.js";
import type { AdapterParseOptions, SourceAdapter } from "./types.js";
import type { TranscriptMessage } from "../types.js";

export const genericJsonlAdapter: SourceAdapter = {
  name: "jsonl-generic",

  canHandle(filePath: string, firstLine?: string): boolean {
    if (filePath.toLowerCase().endsWith(".jsonl")) {
      return true;
    }

    if (!firstLine) {
      return false;
    }

    try {
      const parsed = JSON.parse(firstLine);
      if (!parsed || typeof parsed !== "object") {
        return false;
      }
      return extractGenericMessageCandidate(parsed as Record<string, unknown>) !== null;
    } catch {
      return false;
    }
  },

  async parse(filePath: string, _options?: AdapterParseOptions) {
    const raw = await fs.readFile(filePath, "utf8");
    const warnings: string[] = [];
    const messages: TranscriptMessage[] = [];

    let sessionId: string | undefined;
    let sessionTimestamp: string | undefined;
    let cwd: string | undefined;
    let model: string | undefined;

    parseJsonlLines(raw, warnings, (record) => {
      if (!sessionId && typeof record.sessionId === "string") {
        sessionId = record.sessionId;
      }

      if (record.type === "session") {
        sessionId = typeof record.id === "string" ? record.id : sessionId;
        cwd = typeof record.cwd === "string" ? record.cwd : cwd;
        model = typeof record.model === "string" ? record.model : model;
        sessionTimestamp = extractTimestamp(record) ?? sessionTimestamp;
      }

      if (record.type === "session_meta" && record.payload && typeof record.payload === "object") {
        const payload = record.payload as Record<string, unknown>;
        sessionId = typeof payload.id === "string" ? payload.id : sessionId;
        cwd = typeof payload.cwd === "string" ? payload.cwd : cwd;
        model =
          typeof payload.model === "string"
            ? payload.model
            : typeof payload.model_provider === "string"
              ? payload.model_provider
              : model;
        sessionTimestamp = extractTimestamp(record) ?? extractTimestamp(payload) ?? sessionTimestamp;
      }

      const mapped = extractGenericMessageCandidate(record);
      if (!mapped) {
        return;
      }

      const text = normalizeMessageText(mapped.content);
      if (!text) {
        return;
      }

      messages.push({
        index: messages.length,
        role: mapped.role,
        text,
        timestamp: mapped.timestamp,
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
        platform: "jsonl-generic",
        sessionId,
        cwd,
        model,
        startedAt: sessionTimestamp ?? messages[0]?.timestamp ?? fallbackTimestamp,
      },
    };
  },
};
