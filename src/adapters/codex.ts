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

  async parse(filePath: string) {
    const raw = await fs.readFile(filePath, "utf8");
    const warnings: string[] = [];
    const messages: TranscriptMessage[] = [];

    let sessionId: string | undefined;
    let cwd: string | undefined;
    let model: string | undefined;
    let sessionTimestamp: string | undefined;

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

      if (record.type !== "response_item" || !record.payload || typeof record.payload !== "object") {
        return;
      }

      const payload = record.payload as Record<string, unknown>;
      if (payload.type !== "message") {
        return;
      }

      const role = normalizeRole(payload.role);
      if (!role) {
        return;
      }

      const text = normalizeMessageText(payload.content);
      if (!text) {
        return;
      }

      messages.push({
        index: messages.length,
        role,
        text,
        timestamp: extractTimestamp(record) ?? extractTimestamp(payload),
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
        platform: "codex",
        sessionId,
        cwd,
        model,
        startedAt: sessionTimestamp ?? messages[0]?.timestamp ?? fallbackTimestamp,
      },
    };
  },
};
