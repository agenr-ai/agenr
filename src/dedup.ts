import type { KnowledgeEntry } from "./types.js";

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
  const keepIncomingImportance = incoming.importance > existing.importance;

  const mergedTags = Array.from(new Set([...existing.tags, ...incoming.tags])).sort((a, b) =>
    a.localeCompare(b),
  );

  const sourceContext =
    incoming.source.context.length > existing.source.context.length
      ? incoming.source.context
      : existing.source.context;

  const parseCreatedAt = (value: string | undefined): string | undefined => {
    if (!value || value.trim().length === 0) {
      return undefined;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return undefined;
    }
    return parsed.toISOString();
  };

  const existingCreatedAt = parseCreatedAt(existing.created_at);
  const incomingCreatedAt = parseCreatedAt(incoming.created_at);
  const createdAt =
    existingCreatedAt && incomingCreatedAt
      ? new Date(existingCreatedAt).getTime() >= new Date(incomingCreatedAt).getTime()
        ? existingCreatedAt
        : incomingCreatedAt
      : existingCreatedAt ?? incomingCreatedAt;

  return {
    ...existing,
    importance: keepIncomingImportance ? incoming.importance : existing.importance,
    tags: mergedTags,
    created_at: createdAt,
    source: {
      file: existing.source.file,
      context: sourceContext,
    },
  };
}

interface IndexedEntry {
  entry: KnowledgeEntry;
  firstIndex: number;
}

export function deduplicateEntries(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  const exact = new Map<string, IndexedEntry>();
  const orderedKeys: string[] = [];

  for (const [index, entry] of entries.entries()) {
    const exactKey = `${entry.type}|${normalize(entry.subject)}|${normalize(entry.content)}`;
    const existing = exact.get(exactKey);
    if (!existing) {
      exact.set(exactKey, { entry, firstIndex: index });
      orderedKeys.push(exactKey);
      continue;
    }
    exact.set(exactKey, {
      entry: mergeEntries(existing.entry, entry),
      firstIndex: Math.min(existing.firstIndex, index),
    });
  }

  const deduped = orderedKeys
    .map((key) => exact.get(key))
    .filter((item): item is IndexedEntry => !!item);

  const grouped = new Map<string, IndexedEntry[]>();
  for (const indexed of deduped) {
    const groupKey = `${indexed.entry.type}|${normalize(indexed.entry.subject)}`;
    const current = grouped.get(groupKey) ?? [];
    let merged = false;

    for (let i = 0; i < current.length; i += 1) {
      const candidate = current[i];
      if (!candidate) {
        continue;
      }

      const similarity = jaccard(trigrams(candidate.entry.content), trigrams(indexed.entry.content));
      if (similarity >= 0.85) {
        current[i] = {
          entry: mergeEntries(candidate.entry, indexed.entry),
          firstIndex: Math.min(candidate.firstIndex, indexed.firstIndex),
        };
        merged = true;
        break;
      }
    }

    if (!merged) {
      current.push(indexed);
    }

    grouped.set(groupKey, current);
  }

  const final: IndexedEntry[] = [];
  for (const key of grouped.keys()) {
    final.push(...(grouped.get(key) ?? []));
  }

  final.sort((a, b) => a.firstIndex - b.firstIndex);
  return final.map((item) => item.entry);
}
