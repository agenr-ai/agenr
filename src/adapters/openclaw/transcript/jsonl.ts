/**
 * Stable issue kinds emitted while parsing OpenClaw JSONL payloads.
 */
export type JsonlParseDiagnosticKind = "malformed_json" | "non_object_record";

/**
 * One structured parse issue emitted while scanning JSONL lines.
 */
export interface JsonlParseDiagnostic {
  /**
   * Machine-readable classification for the skipped line.
   */
  kind: JsonlParseDiagnosticKind;
  /**
   * One-based line number in the source document.
   */
  lineNumber: number;
  /**
   * Human-readable description of the issue.
   */
  message: string;
}

/**
 * Structured result for one parsed JSONL object line.
 */
export interface JsonObjectLineParseResult {
  /**
   * Parsed object payload when the line contained one.
   */
  record: Record<string, unknown> | null;
  /**
   * Structured skip diagnostic when the line was non-empty but invalid.
   */
  diagnostic?: JsonlParseDiagnostic;
}

/**
 * Structured result emitted after scanning a JSONL document.
 */
export interface JsonlLinesParseResult {
  /**
   * Structured diagnostics for skipped non-empty lines.
   */
  diagnostics: JsonlParseDiagnostic[];
}

/**
 * Parses a single JSON line when it contains an object payload.
 *
 * @param line - Raw JSONL line text.
 * @returns Parsed object record, or `null` when the line is empty or invalid.
 */
export function parseJsonObjectLine(line: string): Record<string, unknown> | null {
  return parseJsonObjectLineWithDiagnostics(line).record;
}

/**
 * Parses one JSONL line and returns both the record and any structured issue.
 *
 * @param line - Raw JSONL line text.
 * @param lineNumber - One-based source line number for diagnostics.
 * @returns Parsed record plus an optional diagnostic for invalid non-empty data.
 */
export function parseJsonObjectLineWithDiagnostics(line: string, lineNumber = 1): JsonObjectLineParseResult {
  if (!line || line.trim().length === 0) {
    return {
      record: null,
    };
  }

  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        record: parsed as Record<string, unknown>,
      };
    }

    return {
      record: null,
      diagnostic: {
        kind: "non_object_record",
        lineNumber,
        message: `Skipped non-object JSONL line ${lineNumber}`,
      },
    };
  } catch {
    return {
      record: null,
      diagnostic: {
        kind: "malformed_json",
        lineNumber,
        message: `Skipped malformed JSONL line ${lineNumber}`,
      },
    };
  }
}

/**
 * Iterates JSONL lines and invokes a callback for each valid object record.
 *
 * @param raw - Raw JSONL document contents.
 * @param onRecord - Callback invoked with each parsed object record and line number.
 * @returns Structured diagnostics for skipped non-empty lines.
 */
export function parseJsonlLines(raw: string, onRecord: (record: Record<string, unknown>, lineNumber: number) => void): JsonlLinesParseResult {
  const lines = raw.split(/\r?\n/);
  const diagnostics: JsonlParseDiagnostic[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    const parsed = parseJsonObjectLineWithDiagnostics(line, index + 1);
    if (parsed.diagnostic) {
      diagnostics.push(parsed.diagnostic);
      continue;
    }

    if (parsed.record) {
      onRecord(parsed.record, index + 1);
    }
  }

  return {
    diagnostics,
  };
}
