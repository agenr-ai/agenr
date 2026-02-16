import type { Client, InValue } from "@libsql/client";
import { findSimilar } from "../db/store.js";
import { UnionFind, cosineSim, type ActiveEmbeddedEntry, validateCluster } from "./util.js";

const DEFAULT_SIMILARITY_THRESHOLD = 0.85;
const CROSS_TYPE_SUBJECT_THRESHOLD = 0.89;
const DEFAULT_MIN_CLUSTER = 3;
const DEFAULT_MAX_CLUSTER_SIZE = 12;
const DEFAULT_IDEMPOTENCY_DAYS = 7;
const DEFAULT_NEIGHBOR_LIMIT = 20;
const MAX_ACTIVE_EMBEDDED_ENTRIES = 20_000;
const MILLISECONDS_PER_DAY = 1000 * 60 * 60 * 24;

export interface ClusterOptions {
  simThreshold?: number;
  minCluster?: number;
  maxClusterSize?: number;
  typeFilter?: string;
  idempotencyDays?: number;
  neighborLimit?: number;
  verbose?: boolean;
  onLog?: (message: string) => void;
}

export interface Cluster {
  entries: ActiveEmbeddedEntry[];
}

function toNumber(value: InValue | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return Number.NaN;
}

function toStringValue(value: InValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function mapBufferToVector(value: InValue | undefined): number[] {
  if (value instanceof ArrayBuffer) {
    return Array.from(new Float32Array(value));
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return Array.from(
      new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / Float32Array.BYTES_PER_ELEMENT)),
    );
  }

  return [];
}

function normalizeSubject(value: string): string {
  return value.trim().toLowerCase();
}

function parseDaysSince(value: string, now: Date): number {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return Number.POSITIVE_INFINITY;
  }
  return (now.getTime() - parsed.getTime()) / MILLISECONDS_PER_DAY;
}

function mapActiveEmbeddedEntry(row: Record<string, InValue | undefined>): ActiveEmbeddedEntry | null {
  const id = toStringValue(row.id);
  const embedding = mapBufferToVector(row.embedding);

  if (!id || embedding.length === 0) {
    return null;
  }

  return {
    id,
    type: toStringValue(row.type),
    subject: toStringValue(row.subject),
    content: toStringValue(row.content),
    importance: Number.isFinite(toNumber(row.importance)) ? toNumber(row.importance) : 5,
    embedding,
    confirmations: Number.isFinite(toNumber(row.confirmations)) ? toNumber(row.confirmations) : 0,
    recallCount: Number.isFinite(toNumber(row.recall_count)) ? toNumber(row.recall_count) : 0,
    createdAt: toStringValue(row.created_at),
    mergedFrom: Number.isFinite(toNumber(row.merged_from)) ? toNumber(row.merged_from) : 0,
    consolidatedAt: toStringValue(row.consolidated_at) || undefined,
  };
}

function shouldSkipByIdempotency(entry: ActiveEmbeddedEntry, idempotencyDays: number, now: Date): boolean {
  if ((entry.mergedFrom ?? 0) <= 0) {
    return false;
  }
  if (!entry.consolidatedAt) {
    return false;
  }
  const ageInDays = parseDaysSince(entry.consolidatedAt, now);
  return Number.isFinite(ageInDays) && ageInDays >= 0 && ageInDays < idempotencyDays;
}

export async function buildClusters(db: Client, options: ClusterOptions = {}): Promise<Cluster[]> {
  const simThreshold = options.simThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const minCluster = options.minCluster ?? DEFAULT_MIN_CLUSTER;
  const maxClusterSize = options.maxClusterSize ?? DEFAULT_MAX_CLUSTER_SIZE;
  const idempotencyDays = options.idempotencyDays ?? DEFAULT_IDEMPOTENCY_DAYS;
  const neighborLimit = Math.max(2, options.neighborLimit ?? DEFAULT_NEIGHBOR_LIMIT);
  const typeFilter = options.typeFilter?.trim();
  const onLog = options.onLog ?? (() => undefined);

  const result = await db.execute(`
    SELECT id, type, subject, content, importance, embedding, confirmations,
           recall_count, created_at, merged_from, consolidated_at
    FROM entries
    WHERE superseded_by IS NULL
      AND embedding IS NOT NULL
  `);

  const now = new Date();
  const candidates = result.rows
    .map((row) => mapActiveEmbeddedEntry(row))
    .filter((entry): entry is ActiveEmbeddedEntry => Boolean(entry))
    .filter((entry) => (typeFilter ? entry.type === typeFilter : true))
    .filter((entry) => !shouldSkipByIdempotency(entry, idempotencyDays, now));

  if (candidates.length > MAX_ACTIVE_EMBEDDED_ENTRIES) {
    onLog(
      `[cluster] Warning: ${candidates.length} active embedded entries exceed ${MAX_ACTIVE_EMBEDDED_ENTRIES}. Consolidation may be slow.`,
    );
  }

  if (candidates.length < minCluster) {
    return [];
  }

  const entryById = new Map(candidates.map((entry) => [entry.id, entry]));
  const unionFind = new UnionFind();
  for (const entry of candidates) {
    unionFind.add(entry.id);
  }

  for (const entry of candidates) {
    const neighbors = await findSimilar(db, entry.embedding, neighborLimit);
    for (const neighbor of neighbors) {
      const candidate = entryById.get(neighbor.entry.id);
      if (!candidate || candidate.id === entry.id) {
        continue;
      }

      const similarity = cosineSim(entry.embedding, candidate.embedding);
      const sameType = entry.type === candidate.type;
      const sameSubject = normalizeSubject(entry.subject) === normalizeSubject(candidate.subject);

      if ((sameType && similarity >= simThreshold) || (sameSubject && similarity >= CROSS_TYPE_SUBJECT_THRESHOLD)) {
        unionFind.union(entry.id, candidate.id);
      }
    }
  }

  const groups = new Map<string, ActiveEmbeddedEntry[]>();
  for (const entry of candidates) {
    const root = unionFind.find(entry.id);
    const group = groups.get(root) ?? [];
    group.push(entry);
    groups.set(root, group);
  }

  const diameterFloor = Math.max(0, simThreshold - 0.02);
  const clusters: Cluster[] = [];

  for (const group of groups.values()) {
    if (group.length < minCluster) {
      continue;
    }

    const validated = validateCluster(group, maxClusterSize, diameterFloor);
    if (validated.length < minCluster) {
      continue;
    }

    clusters.push({ entries: validated });
  }

  if (options.verbose) {
    onLog(
      `[cluster] candidates=${candidates.length} clusters=${clusters.length} minCluster=${minCluster} simThreshold=${simThreshold.toFixed(2)} neighborLimit=${neighborLimit}`,
    );
  }

  return clusters;
}
