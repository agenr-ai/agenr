import type { ResultSet } from "@libsql/client";

import { buildFtsQueries } from "../../core/recall/lexical.js";
import type { EntryFilters, FtsCandidate } from "../../core/recall/types.js";
import type { EmbeddingPort, RecallPorts } from "../../core/ports.js";
import { recordRecallEvent, type SqlExecutor } from "./queries.js";
import {
  buildActiveEntryClause,
  cosineSimilarity,
  mapEntryRow,
  readEmbedding,
  readNumber,
  readRequiredString,
  serializeEmbeddingForVector,
} from "./row-mapping.js";

const ENTRY_SELECT_COLUMNS = `
  e.id,
  e.type,
  e.subject,
  e.content,
  e.importance,
  e.expiry,
  e.tags,
  e.source_file,
  e.source_context,
  e.embedding,
  e.content_hash,
  e.norm_content_hash,
  e.quality_score,
  e.recall_count,
  e.last_recalled_at,
  e.superseded_by,
  e.cluster_id,
  e.retired,
  e.retired_at,
  e.retired_reason,
  e.created_at,
  e.updated_at
`;

const FTS_TIERS = ["exact", "all_tokens", "any_tokens"] as const;

/**
 * Creates a libSQL-backed recall adapter by composing SQL execution and embeddings.
 *
 * @param executor - SQL executor used for retrieval and telemetry writes.
 * @param embeddingPort - Embedding provider used for query embedding.
 * @returns Recall port implementation for the v1 recall pipeline.
 */
export function createRecallAdapter(executor: SqlExecutor, embeddingPort: EmbeddingPort): RecallPorts {
  return new LibsqlRecallAdapter(executor, embeddingPort);
}

/** libSQL implementation of the recall query-time adapter contract. */
class LibsqlRecallAdapter implements RecallPorts {
  private pendingWrites: Promise<void> = Promise.resolve();

  /**
   * Creates a recall adapter over a SQL executor and embedding provider.
   *
   * @param executor - SQL executor used for reads and telemetry writes.
   * @param embeddingPort - Embedding provider used for query embeddings.
   */
  public constructor(
    private readonly executor: SqlExecutor,
    private readonly embeddingPort: EmbeddingPort,
  ) {}

  /** Computes the query embedding by reusing the shared embedding port. */
  public async embed(text: string): Promise<number[]> {
    const results = await this.embeddingPort.embed([text]);
    return results[0] ?? [];
  }

  /** Finds hydrated vector candidates with SQL-level filters applied. */
  public async vectorSearch(params: {
    embedding: number[];
    limit: number;
    filters?: EntryFilters;
  }): Promise<Array<{ entry: import("../../core/types.js").Entry; vectorSim: number }>> {
    if (params.limit <= 0 || params.embedding.length === 0) {
      return [];
    }

    const serializedEmbedding = serializeEmbeddingForVector(params.embedding);
    if (!serializedEmbedding) {
      return [];
    }

    const filters = buildEntryFilterClause(params.filters, "e");
    let result: ResultSet;

    try {
      result = await this.executor.execute({
        sql: `
          SELECT
            ${ENTRY_SELECT_COLUMNS}
          FROM vector_top_k('idx_entries_embedding', vector32(?), ?) AS v
          JOIN entries AS e ON e.rowid = v.id
          WHERE ${buildActiveEntryClause("e")}
            ${filters.sql}
          LIMIT ?
        `,
        args: [serializedEmbedding, params.limit, ...filters.args, params.limit],
      });
    } catch (error) {
      throw wrapVectorError(error);
    }

    return result.rows
      .map((row) => ({
        entry: mapEntryRow(row),
        vectorSim: cosineSimilarity(params.embedding, readEmbedding(row, "embedding")),
      }))
      .filter((candidate) => candidate.vectorSim > 0)
      .sort((left, right) => right.vectorSim - left.vectorSim)
      .slice(0, params.limit);
  }

  /** Finds hydrated FTS candidates using the exact -> AND -> OR cascade. */
  public async ftsSearch(params: { text: string; limit: number; filters?: EntryFilters }): Promise<FtsCandidate[]> {
    if (params.limit <= 0) {
      return [];
    }

    const queries = buildFtsQueries(params.text);
    if (queries.length === 0) {
      return [];
    }

    const filters = buildEntryFilterClause(params.filters, "e");
    const matches = new Map<string, FtsCandidate>();

    for (const [index, query] of queries.entries()) {
      let result: ResultSet;
      try {
        result = await this.executor.execute({
          sql: `
            SELECT
              ${ENTRY_SELECT_COLUMNS},
              bm25(entries_fts, 1.0, 2.0) AS rank
            FROM entries_fts
            JOIN entries AS e ON e.rowid = entries_fts.rowid
            WHERE entries_fts MATCH ?
              AND ${buildActiveEntryClause("e")}
              ${filters.sql}
            ORDER BY bm25(entries_fts, 1.0, 2.0)
            LIMIT ?
          `,
          args: [query, ...filters.args, params.limit],
        });
      } catch {
        continue;
      }

      const tier = FTS_TIERS[index] ?? FTS_TIERS[FTS_TIERS.length - 1];
      for (const row of result.rows) {
        const entryId = readRequiredString(row, "id");
        if (matches.has(entryId)) {
          continue;
        }

        matches.set(entryId, {
          entry: mapEntryRow(row),
          rank: readNumber(row, "rank", Number.POSITIVE_INFINITY),
          tier,
        });
      }
    }

    return Array.from(matches.values())
      .sort((left, right) => compareFtsCandidates(left, right))
      .slice(0, params.limit);
  }

  /**
   * Queues recall telemetry writes so callers can fire-and-forget and still flush later.
   *
   * Errors are swallowed per entry because telemetry must never fail recall.
   */
  public async recordRecallEvents(params: { entryIds: string[]; query: string; sessionKey?: string }): Promise<void> {
    const task = this.pendingWrites.then(async () => {
      for (const entryId of params.entryIds) {
        try {
          await recordRecallEvent(this.executor, entryId, params.query, params.sessionKey);
        } catch {
          // Swallow telemetry failures so recall responses are never blocked by writes.
        }
      }
    });

    this.pendingWrites = task.catch(() => undefined);
    await task;
  }

  /** Waits for any in-flight recall telemetry writes to finish. */
  public async flush(): Promise<void> {
    await this.pendingWrites;
  }
}

/**
 * Builds SQL WHERE fragments and bound arguments for recall filters.
 *
 * @param filters - Optional recall filters.
 * @param alias - Table alias used in the query.
 * @returns SQL fragment prefixed with `AND` clauses plus the matching args.
 */
function buildEntryFilterClause(filters: EntryFilters | undefined, alias: string): { sql: string; args: Array<string | number> } {
  if (!filters) {
    return { sql: "", args: [] };
  }

  const clauses: string[] = [];
  const args: Array<string | number> = [];

  const types = normalizeStrings(filters.types);
  if (types.length > 0) {
    clauses.push(`${alias}.type IN (${types.map(() => "?").join(", ")})`);
    args.push(...types);
  }

  const tags = normalizeStrings(filters.tags);
  for (const tag of tags) {
    clauses.push(`(${alias}.tags LIKE '%|' || ? || '|%' OR ${alias}.tags LIKE '%' || ? || '%')`);
    args.push(tag, JSON.stringify(tag));
  }

  if (filters.since) {
    clauses.push(`${alias}.created_at >= ?`);
    args.push(filters.since.toISOString());
  }

  if (filters.until) {
    clauses.push(`${alias}.created_at <= ?`);
    args.push(filters.until.toISOString());
  }

  if (clauses.length === 0) {
    return { sql: "", args };
  }

  return {
    sql: `AND ${clauses.join("\n              AND ")}`,
    args,
  };
}

/** Normalizes and deduplicates optional string filter arrays. */
function normalizeStrings(values: string[] | undefined): string[] {
  if (!values) {
    return [];
  }

  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

/** Orders FTS candidates by tier priority first, then by BM25 rank. */
function compareFtsCandidates(left: FtsCandidate, right: FtsCandidate): number {
  const tierDelta = ftsTierPriority(left.tier) - ftsTierPriority(right.tier);
  if (tierDelta !== 0) {
    return tierDelta;
  }

  return left.rank - right.rank;
}

/** Resolves a stable numeric sort priority for one FTS cascade tier. */
function ftsTierPriority(tier: FtsCandidate["tier"]): number {
  return FTS_TIERS.indexOf(tier);
}

/** Wraps vector-search failures in a consistent adapter error. */
function wrapVectorError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Vector search is unavailable: ${message}`);
}
