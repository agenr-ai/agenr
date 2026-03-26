/**
 * Parses a single JSON line when it contains an object payload.
 *
 * @param line - Raw JSONL line text.
 * @returns Parsed object record, or `null` when the line is empty or invalid.
 */
export function parseJsonObjectLine(line: string): Record<string, unknown> | null {
  if (!line || line.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Iterates JSONL lines and invokes a callback for each valid object record.
 *
 * @param raw - Raw JSONL document contents.
 * @param warnings - Warning accumulator for malformed lines.
 * @param onRecord - Callback invoked with each parsed object record and line number.
 */
export function parseJsonlLines(raw: string, warnings: string[], onRecord: (record: Record<string, unknown>, lineNumber: number) => void): void {
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push(`Skipped malformed JSONL line ${index + 1}`);
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }

    onRecord(parsed as Record<string, unknown>, index + 1);
  }
}
