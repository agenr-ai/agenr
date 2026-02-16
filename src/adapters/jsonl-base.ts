import fs from "node:fs/promises";
import path from "node:path";
import type { TranscriptMessage } from "../types.js";

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function parseTimestampValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value > 1e12 ? value : value * 1000;
    const parsed = new Date(ms);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return undefined;
}

export function extractTimestamp(record: Record<string, unknown>): string | undefined {
  const fields = ["timestamp", "ts", "created_at", "createdAt", "time", "date"];
  for (const field of fields) {
    const parsed = parseTimestampValue(record[field]);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

export function firstNonEmptyLine(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

export async function readFirstNonEmptyLine(filePath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return firstNonEmptyLine(raw);
  } catch {
    return undefined;
  }
}

export function parseJsonObjectLine(line: string): Record<string, unknown> | null {
  if (!line || line.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function extractTextBlocks(content: unknown): string[] {
  if (typeof content === "string") {
    const normalized = normalizeWhitespace(content);
    return normalized ? [normalized] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const out: string[] = [];
  let nonTextCount = 0;

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const record = block as Record<string, unknown>;
    if (typeof record.text === "string") {
      const normalized = normalizeWhitespace(record.text);
      if (normalized) {
        out.push(normalized);
      }
      continue;
    }

    if (
      typeof record.content === "string" &&
      (record.type === "input_text" || record.type === "output_text" || record.type === "text")
    ) {
      const normalized = normalizeWhitespace(record.content);
      if (normalized) {
        out.push(normalized);
      }
      continue;
    }

    nonTextCount += 1;
  }

  if (out.length === 0 && nonTextCount > 0) {
    out.push(`[non-text content omitted: ${nonTextCount} block${nonTextCount === 1 ? "" : "s"}]`);
  }

  return out;
}

export type NormalizedRole = TranscriptMessage["role"];

export function normalizeRole(value: unknown): NormalizedRole | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "user" || normalized === "human") {
    return "user";
  }
  if (normalized === "assistant" || normalized === "ai" || normalized === "developer") {
    return "assistant";
  }

  return null;
}

export function normalizeMessageText(content: unknown): string {
  return normalizeWhitespace(extractTextBlocks(content).join("\n"));
}

export interface MessageCandidate {
  role: NormalizedRole;
  content: unknown;
  timestamp?: string;
}

export function extractGenericMessageCandidate(record: Record<string, unknown>): MessageCandidate | null {
  if ("role" in record && "content" in record) {
    const role = normalizeRole(record.role);
    if (role) {
      return {
        role,
        content: record.content,
        timestamp: extractTimestamp(record),
      };
    }
  }

  if (record.type === "message" && record.message && typeof record.message === "object") {
    const message = record.message as Record<string, unknown>;
    const role = normalizeRole(message.role);
    if (!role) {
      return null;
    }

    return {
      role,
      content: message.content,
      timestamp: extractTimestamp(record) ?? extractTimestamp(message),
    };
  }

  if (typeof record.type === "string") {
    const topRole = normalizeRole(record.type);
    if (topRole && ("content" in record || "message" in record)) {
      const message = record.message && typeof record.message === "object" ? (record.message as Record<string, unknown>) : null;
      const content = message && "content" in message ? message.content : record.content;
      return {
        role: topRole,
        content,
        timestamp: extractTimestamp(record) ?? (message ? extractTimestamp(message) : undefined),
      };
    }
  }

  if (record.payload && typeof record.payload === "object") {
    const payload = record.payload as Record<string, unknown>;
    if (payload.type === "message") {
      const role = normalizeRole(payload.role);
      if (!role) {
        return null;
      }

      return {
        role,
        content: payload.content,
        timestamp: extractTimestamp(record) ?? extractTimestamp(payload),
      };
    }
  }

  return null;
}

export function looksLikeTranscriptJsonLine(line: string): boolean {
  const parsed = parseJsonObjectLine(line);
  if (!parsed) {
    return false;
  }
  return extractGenericMessageCandidate(parsed) !== null;
}

export function parseJsonlLines(
  raw: string,
  warnings: string[],
  onRecord: (record: Record<string, unknown>, lineNumber: number) => void,
): void {
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push(`Skipped malformed JSONL line ${i + 1}`);
      continue;
    }

    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    onRecord(parsed as Record<string, unknown>, i + 1);
  }
}

export async function getFileMtimeTimestamp(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return parseTimestampValue(stat.mtime.toISOString());
  } catch {
    return undefined;
  }
}

export async function resolveTimestampFallback(
  filePath: string,
  ...candidates: Array<string | undefined>
): Promise<string> {
  for (const candidate of candidates) {
    const parsed = parseTimestampValue(candidate);
    if (parsed) {
      return parsed;
    }
  }

  const mtime = await getFileMtimeTimestamp(filePath);
  if (mtime) {
    return mtime;
  }

  return new Date().toISOString();
}

export async function applyMessageTimestampFallbacks(
  filePath: string,
  messages: TranscriptMessage[],
  options?: {
    sessionTimestamp?: string;
    filenameTimestamp?: string;
  },
): Promise<string> {
  const fallback = await resolveTimestampFallback(filePath, options?.sessionTimestamp, options?.filenameTimestamp);

  for (const message of messages) {
    message.timestamp = parseTimestampValue(message.timestamp) ?? fallback;
  }

  return fallback;
}

export function parsePlaudFilenameTimestamp(filePath: string): string | undefined {
  const fileName = path.basename(filePath);
  const match = /^(\d{4}-\d{2}-\d{2})\s(\d{4})\s-\s.+\s-\s.+\.md$/i.exec(fileName);
  if (!match) {
    return undefined;
  }

  const datePart = match[1];
  const hm = match[2];
  const hours = hm.slice(0, 2);
  const minutes = hm.slice(2, 4);
  const parsed = new Date(`${datePart}T${hours}:${minutes}:00`);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed.toISOString();
}
