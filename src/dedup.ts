import type { ConfidenceLevel, KnowledgeEntry } from "./types.js";

const confidenceRank: Record<ConfidenceLevel, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigrams(value: string): Set<string> {
  const tokens = normalize(value).split(" ").filter(Boolean);
  if (tokens.length < 3) {
    return new Set([tokens.join(" ")]);
  }

  const out = new Set<string>();
  for (let i = 0; i <= tokens.length - 3; i += 1) {
    out.add(tokens.slice(i, i + 3).join(" "));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function mergeEntries(existing: KnowledgeEntry, incoming: KnowledgeEntry): KnowledgeEntry {
  const keepIncomingConfidence =
    confidenceRank[incoming.confidence] > confidenceRank[existing.confidence];

  const mergedTags = Array.from(new Set([...existing.tags, ...incoming.tags])).sort((a, b) =>
    a.localeCompare(b),
  );

  const sourceContext =
    incoming.source.context.length > existing.source.context.length
      ? incoming.source.context
      : existing.source.context;

  return {
    ...existing,
    confidence: keepIncomingConfidence ? incoming.confidence : existing.confidence,
    tags: mergedTags,
    source: {
      file: existing.source.file,
      context: sourceContext,
    },
  };
}

export function deduplicateEntries(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  const exact = new Map<string, KnowledgeEntry>();
  const orderedKeys: string[] = [];

  for (const entry of entries) {
    const exactKey = `${entry.type}|${normalize(entry.subject)}|${normalize(entry.content)}`;
    const existing = exact.get(exactKey);
    if (!existing) {
      exact.set(exactKey, entry);
      orderedKeys.push(exactKey);
      continue;
    }
    exact.set(exactKey, mergeEntries(existing, entry));
  }

  const deduped = orderedKeys.map((key) => exact.get(key)).filter((entry): entry is KnowledgeEntry => !!entry);

  const grouped = new Map<string, KnowledgeEntry[]>();
  for (const entry of deduped) {
    const groupKey = `${entry.type}|${normalize(entry.subject)}`;
    const current = grouped.get(groupKey) ?? [];
    let merged = false;

    for (let i = 0; i < current.length; i += 1) {
      const candidate = current[i];
      if (!candidate) {
        continue;
      }

      const similarity = jaccard(trigrams(candidate.content), trigrams(entry.content));
      if (similarity >= 0.85) {
        current[i] = mergeEntries(candidate, entry);
        merged = true;
        break;
      }
    }

    if (!merged) {
      current.push(entry);
    }

    grouped.set(groupKey, current);
  }

  const final: KnowledgeEntry[] = [];
  for (const key of grouped.keys()) {
    final.push(...(grouped.get(key) ?? []));
  }

  return final;
}
