import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { formatErrorMessage } from "../../shared/errors.js";
import { isRecord, readOptionalFiniteNumber, readOptionalTrimmedString } from "../../shared/validation.js";
import type { TranscriptPort } from "../../../core/ports.js";
import type { ParsedTranscript, TranscriptMessage } from "../../../core/types.js";

/** Parser for Skeln session JSONL exports. */
export class SkelnTranscriptParser implements TranscriptPort {
  /**
   * Parses one Skeln session JSONL file into normalized transcript messages.
   *
   * @param filePath - Absolute or relative Skeln session file.
   * @returns Parsed transcript payload consumed by shared episode ingest.
   */
  public async parseFile(filePath: string): Promise<ParsedTranscript> {
    const raw = await fs.readFile(filePath, "utf8");
    const transcriptHash = createHash("sha256").update(raw).digest("hex");
    const warnings: string[] = [];
    const messages: TranscriptMessage[] = [];
    const records = parseJsonlRecords(raw, filePath, warnings);
    const header = records[0] ? parseHeaderRecord(records[0], filePath, warnings) : {};
    const sessionId = header.sessionId ?? deriveSkelnSessionIdFromFilePath(filePath);
    const headerTimestamp = toIsoTimestamp(header.timestamp);

    for (const record of records.slice(1)) {
      if (record.type !== "message") {
        continue;
      }

      const normalized = normalizeSkelnMessage(record.message);
      if (!normalized) {
        continue;
      }

      messages.push({
        index: messages.length,
        role: normalized.role,
        text: normalized.text,
        ...(normalized.timestamp ? { timestamp: normalized.timestamp } : {}),
      });
    }

    const startedAt = messages[0]?.timestamp ?? headerTimestamp;
    const endedAt = messages.at(-1)?.timestamp;

    return {
      messages,
      metadata: {
        ...(sessionId ? { sessionId } : {}),
        ...(header.cwd ? { workingDirectory: header.cwd, project: path.basename(header.cwd) } : {}),
        ...(startedAt ? { startedAt } : {}),
        ...(endedAt ? { endedAt } : {}),
        messageCount: messages.length,
        transcriptHash,
        reconstructedSurface: "skeln",
        surfaceReconstructionSource: "reconstructed",
        sourceIdentity: path.resolve(filePath),
        sourceIdentityKind: "skeln_session_file",
      },
      warnings,
    };
  }
}

const skelnTranscriptParser = new SkelnTranscriptParser();

export { skelnTranscriptParser };

/** Minimal Skeln session header facts needed by episode ingest. */
interface SkelnSessionHeaderFacts {
  /** Stable session id when present. */
  sessionId?: string;
  /** Session creation timestamp in milliseconds. */
  timestamp?: number;
  /** Working directory recorded by Skeln. */
  cwd?: string;
}

/** Normalized Skeln message fact. */
interface NormalizedSkelnMessage {
  /** Role accepted by episode transcript rendering. */
  role: "user" | "assistant";
  /** Clean text content. */
  text: string;
  /** Message timestamp when present. */
  timestamp?: string;
}

/** Parses non-empty JSONL object records. */
function parseJsonlRecords(raw: string, filePath: string, warnings: string[]): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  const lines = raw.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      const record = isRecord(parsed) ? parsed : undefined;
      if (!record) {
        warnings.push(`Skipped non-object Skeln JSONL line ${index + 1} in ${filePath}.`);
        continue;
      }

      records.push(record);
    } catch (error) {
      warnings.push(`Skipped malformed Skeln JSONL line ${index + 1} in ${filePath}: ${formatErrorMessage(error)}`);
    }
  }

  if (records.length === 0) {
    warnings.push(`Skipped empty Skeln transcript file: ${filePath}`);
  }

  return records;
}

/** Parses the first non-empty JSONL object record as a Skeln session header. */
function parseHeaderRecord(record: Record<string, unknown> | undefined, filePath: string, warnings: string[]): SkelnSessionHeaderFacts {
  if (!record || record.type !== "session") {
    warnings.push(`Skeln transcript ${filePath} is missing a session header.`);
    return {};
  }

  return {
    sessionId: readOptionalTrimmedString(record.id),
    timestamp: readOptionalFiniteNumber(record.timestamp),
    cwd: readOptionalTrimmedString(record.cwd),
  };
}

/** Normalizes one Skeln message record into user or assistant transcript text. */
function normalizeSkelnMessage(value: unknown): NormalizedSkelnMessage | undefined {
  const message = isRecord(value) ? value : undefined;
  if (!message) {
    return undefined;
  }

  const role = normalizeRole(readOptionalTrimmedString(message.role));
  if (!role) {
    return undefined;
  }

  const text = normalizeMessageText(message.content);
  if (!text) {
    return undefined;
  }

  const timestamp = toIsoTimestamp(readOptionalFiniteNumber(message.timestamp));
  return {
    role,
    text,
    ...(timestamp ? { timestamp } : {}),
  };
}

/** Maps Skeln message roles into episode transcript roles. */
function normalizeRole(role: string | undefined): "user" | "assistant" | undefined {
  if (role === "user") {
    return "user";
  }

  if (role === "assistant") {
    return "assistant";
  }

  return undefined;
}

/** Extracts display text from Skeln message content shapes. */
function normalizeMessageText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (!Array.isArray(value)) {
    return "";
  }

  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }

    const record = isRecord(part) ? part : undefined;
    const text = readOptionalTrimmedString(record?.text) ?? readOptionalTrimmedString(record?.content);
    if (text) {
      parts.push(text);
    }
  }

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Converts a numeric millisecond timestamp into ISO format. */
function toIsoTimestamp(timestamp: number | undefined): string | undefined {
  if (timestamp === undefined) {
    return undefined;
  }

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Derives a stable session id from a Skeln session file path. */
function deriveSkelnSessionIdFromFilePath(filePath: string): string | undefined {
  const basename = path
    .basename(filePath)
    .replace(/\.jsonl(?:\..*)?$/iu, "")
    .trim();
  return basename.length > 0 ? basename : undefined;
}
