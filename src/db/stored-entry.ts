import type { KnowledgePlatform, StoredEntry } from "../types.js";
import { toNumber, toStringValue } from "../utils/entry-utils.js";

interface RawStoredEntryFields {
  id?: unknown;
  type?: unknown;
  subject?: unknown;
  content?: unknown;
  canonical_key?: unknown;
  importance?: unknown;
  expiry?: unknown;
  scope?: unknown;
  platform?: unknown;
  project?: unknown;
  source_file?: unknown;
  source_context?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  last_recalled_at?: unknown;
  recall_count?: unknown;
  recall_intervals?: unknown;
  confirmations?: unknown;
  contradictions?: unknown;
  superseded_by?: unknown;
  retired?: unknown;
  retired_at?: unknown;
  retired_reason?: unknown;
  suppressed_contexts?: unknown;
}

interface MapStoredEntryOptions {
  tags: string[];
  embedding?: number[];
}

export function mapRawStoredEntry(
  row: RawStoredEntryFields,
  options: MapStoredEntryOptions,
): StoredEntry {
  const canonicalKey = toStringValue(row.canonical_key).trim();
  const platform = toStringValue(row.platform).trim();
  const project = toStringValue(row.project).trim();
  const scopeRaw = toStringValue(row.scope).trim();
  const importanceRaw = toNumber(row.importance);
  const recallCountRaw = toNumber(row.recall_count);
  const confirmationsRaw = toNumber(row.confirmations);
  const contradictionsRaw = toNumber(row.contradictions);
  const retiredRaw = toNumber(row.retired);
  const suppressedContextsRaw = toStringValue(row.suppressed_contexts);
  let suppressedContexts: string[] | undefined;
  if (suppressedContextsRaw) {
    try {
      const parsed = JSON.parse(suppressedContextsRaw) as unknown;
      if (Array.isArray(parsed)) {
        suppressedContexts = parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      suppressedContexts = undefined;
    }
  }

  // Parse recall_intervals from JSON string stored in DB.
  // Corrupt or missing data falls back to undefined (spacingFactor will use 1.0).
  let recallIntervals: number[] | undefined;
  const rawIntervals = row.recall_intervals;
  if (typeof rawIntervals === "string" && rawIntervals.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(rawIntervals);
      if (Array.isArray(parsed)) {
        recallIntervals = parsed.filter(
          (v): v is number => typeof v === "number" && Number.isFinite(v),
        );
      }
    } catch {
      // Corrupt JSON - fall back to undefined. Do not throw.
    }
  }

  const entry: StoredEntry = {
    id: toStringValue(row.id),
    type: toStringValue(row.type) as StoredEntry["type"],
    subject: toStringValue(row.subject),
    content: toStringValue(row.content),
    ...(canonicalKey ? { canonical_key: canonicalKey } : {}),
    ...(platform ? { platform: platform as KnowledgePlatform } : {}),
    ...(project ? { project: project.toLowerCase() } : {}),
    importance: Number.isFinite(importanceRaw) ? Math.min(10, Math.max(1, Math.round(importanceRaw))) : 5,
    expiry: toStringValue(row.expiry) as StoredEntry["expiry"],
    scope: (scopeRaw || "private") as StoredEntry["scope"],
    tags: options.tags,
    source: {
      file: toStringValue(row.source_file),
      context: toStringValue(row.source_context),
    },
    created_at: toStringValue(row.created_at),
    updated_at: toStringValue(row.updated_at),
    last_recalled_at: toStringValue(row.last_recalled_at) || undefined,
    recall_count: Number.isFinite(recallCountRaw) ? recallCountRaw : 0,
    ...(recallIntervals !== undefined ? { recall_intervals: recallIntervals } : {}),
    confirmations: Number.isFinite(confirmationsRaw) ? confirmationsRaw : 0,
    contradictions: Number.isFinite(contradictionsRaw) ? contradictionsRaw : 0,
    superseded_by: toStringValue(row.superseded_by) || undefined,
    retired: Number.isFinite(retiredRaw) ? retiredRaw > 0 : false,
    retired_at: toStringValue(row.retired_at) || undefined,
    retired_reason: toStringValue(row.retired_reason) || undefined,
    suppressed_contexts: suppressedContexts,
  };

  if (options.embedding !== undefined) {
    entry.embedding = options.embedding;
  }

  return entry;
}
