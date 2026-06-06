import type { ResultSet, Row } from "@libsql/client";

import { parseClaimKeyStatus } from "../../core/claim-key-lifecycle.js";
import { buildLexicalPlan } from "../../core/recall/lexical.js";
import type { DurableNeighborhoodRequest, NeighborhoodFamily } from "../../core/recall/neighborhood.js";
import type { DurableFilters, FtsCandidate, RecallCandidateDurable } from "../../core/recall/types.js";
import type { EmbeddingPort, RecallPorts } from "../../core/ports.js";
import type { Durable } from "../../core/types.js";
import { compileLexicalTier } from "./fts-compile.js";
import { recordRecallEvent, type SqlExecutor } from "./queries.js";
import {
  buildActiveDurableClause,
  buildHistoricalMemoryClause,
  buildStaleMemoryClause,
  buildValidAsOfClause,
  cosineSimilarity,
  DURABLE_SELECT_COLUMNS,
  mapDurableRow,
  readEmbedding,
  readNumber,
  readOptionalString,
  readRequiredString,
  serializeEmbeddingForVector,
} from "./row-mapping.js";

const RECALL_CANDIDATE_SELECT_COLUMNS = `
  e.id,
  e.subject,
  e.content,
  e.importance,
  e.expiry,
  e.embedding,
  e.superseded_by,
  e.claim_key,
  e.claim_key_status,
  e.claim_support_observed_at,
  e.valid_from,
  e.valid_to,
  e.created_at
`;

const FTS_TIERS = ["exact", "all_tokens", "any_tokens"] as const;
const NEIGHBORHOOD_DEFAULT_BUDGET_CAP = 40;
const NEIGHBORHOOD_PER_SEED_BUDGET = 8;

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

  /** Finds ranking-time vector candidates with SQL-level filters applied. */
  public async vectorSearch(params: {
    embedding: number[];
    limit: number;
    filters?: DurableFilters;
  }): Promise<Array<{ entry: RecallCandidateDurable; vectorSim: number }>> {
    if (params.limit <= 0 || params.embedding.length === 0) {
      return [];
    }

    const serializedEmbedding = serializeEmbeddingForVector(params.embedding);
    if (!serializedEmbedding) {
      return [];
    }

    const filters = buildEntryFilterClause(params.filters, "e");
    const activityClause = buildRecallActivityClause(params.filters, "e");
    let result: ResultSet;

    try {
      result = await this.executor.execute({
        sql: `
          SELECT
            ${RECALL_CANDIDATE_SELECT_COLUMNS}
          FROM vector_top_k('idx_durables_embedding', vector32(?), ?) AS v
          JOIN durables AS e ON e.rowid = v.id
          WHERE ${activityClause}
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
        entry: mapRecallCandidateRow(row),
        vectorSim: cosineSimilarity(params.embedding, readEmbedding(row, "embedding")),
      }))
      .filter((candidate) => candidate.vectorSim > 0)
      .sort((left, right) => right.vectorSim - left.vectorSim)
      .slice(0, params.limit);
  }

  /** Finds ranking-time FTS candidates using the exact -> AND -> OR cascade. */
  public async ftsSearch(params: { text: string; limit: number; filters?: DurableFilters }): Promise<FtsCandidate[]> {
    if (params.limit <= 0) {
      return [];
    }

    const plan = buildLexicalPlan(params.text);
    if (plan.length === 0) {
      return [];
    }

    const filters = buildEntryFilterClause(params.filters, "e");
    const activityClause = buildRecallActivityClause(params.filters, "e");
    const matches = new Map<string, FtsCandidate>();

    for (const tier of plan) {
      const query = compileLexicalTier(tier);
      let result: ResultSet;
      try {
        result = await this.executor.execute({
          sql: `
            SELECT
              ${RECALL_CANDIDATE_SELECT_COLUMNS},
              bm25(durables_fts, 1.0, 2.0) AS rank
            FROM durables_fts
            JOIN durables AS e ON e.rowid = durables_fts.rowid
            WHERE durables_fts MATCH ?
              AND ${activityClause}
              ${filters.sql}
            ORDER BY bm25(durables_fts, 1.0, 2.0)
            LIMIT ?
          `,
          args: [query, ...filters.args, params.limit],
        });
      } catch {
        continue;
      }

      for (const row of result.rows) {
        const entryId = readRequiredString(row, "id");
        if (matches.has(entryId)) {
          continue;
        }

        matches.set(entryId, {
          entry: mapRecallCandidateRow(row),
          rank: readNumber(row, "rank", Number.POSITIVE_INFINITY),
          tier: tier.tier,
        });
      }
    }

    return Array.from(matches.values())
      .sort((left, right) => compareFtsCandidates(left, right))
      .slice(0, params.limit);
  }

  /**
   * Expand a typed entry neighborhood around a seed set of candidate IDs.
   *
   * Honors the requested `families` exactly. `supersession_chain` adds rows
   * that either supersede or are superseded by a seed. `claim_key_sibling`
   * adds rows sharing a claim key with any seed. `topic_family` adds rows
   * that share an exact subject with a seed and is the weakest fallback.
   * `includeHistorical` is applied as a hard gate so the default ranking
   * profile never pulls historical rows into its candidate pool.
   */
  public async expandNeighborhood(request: DurableNeighborhoodRequest): Promise<RecallCandidateDurable[]> {
    const normalizedIds = normalizeStrings(request.seedIds);
    if (normalizedIds.length === 0) {
      return [];
    }

    const families = dedupeFamilies(request.families);
    if (families.length === 0) {
      return [];
    }

    const includeHistorical = request.includeHistorical === true;
    const budget = normalizeNeighborhoodBudget(request.budget, normalizedIds.length);
    const placeholders = normalizedIds.map(() => "?").join(", ");
    const historicalGate = includeHistorical ? "" : `AND ${buildActiveDurableClause("e")}`;
    const priorityExpression = buildNeighborhoodPriorityExpression(families, includeHistorical);
    const membershipExpression = buildNeighborhoodMembershipExpression(families);
    const result = await this.executor.execute({
      sql: `
        WITH seed AS (
          SELECT id, subject, claim_key, superseded_by
          FROM durables
          WHERE id IN (${placeholders})
        ),
        seed_subjects AS (
          SELECT DISTINCT subject
          FROM seed
          WHERE TRIM(subject) <> ''
        ),
        seed_claim_keys AS (
          SELECT DISTINCT claim_key
          FROM seed
          WHERE claim_key IS NOT NULL
        ),
        seed_supersessions AS (
          SELECT DISTINCT superseded_by AS target_id
          FROM seed
          WHERE superseded_by IS NOT NULL
        ),
        neighborhood AS (
          SELECT
            ${RECALL_CANDIDATE_SELECT_COLUMNS},
            ${priorityExpression} AS family_priority
          FROM durables AS e
          WHERE e.id NOT IN (SELECT id FROM seed)
            ${historicalGate}
            AND (${membershipExpression})
        )
        SELECT *
        FROM neighborhood
        ORDER BY family_priority ASC, created_at ASC, id ASC
        LIMIT ?
      `,
      args: [...normalizedIds, budget],
    });

    return result.rows.map((row) => mapRecallCandidateRow(row));
  }

  /** Hydrates full entries for the final ranked result set. */
  public async hydrateEntries(ids: string[]): Promise<Durable[]> {
    const normalizedIds = normalizeStrings(ids);
    if (normalizedIds.length === 0) {
      return [];
    }

    const placeholders = normalizedIds.map(() => "?").join(", ");
    const result = await this.executor.execute({
      sql: `
        SELECT
          ${DURABLE_SELECT_COLUMNS}
        FROM durables AS e
        WHERE e.id IN (${placeholders})
      `,
      args: normalizedIds,
    });

    return result.rows.map((row) => mapDurableRow(row));
  }

  /**
   * Queues telemetry writes internally while keeping recall callers synchronous.
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
    await this.pendingWrites;
  }
}

/**
 * Builds the recall activity gate for vector and lexical candidate queries.
 *
 * Default recall excludes superseded and stale rows using the live clock.
 * As-of recall replaces the live stale gate with supersession-only filtering
 * because temporal bounds come from {@link buildValidAsOfClause}.
 */
function buildRecallActivityClause(filters: DurableFilters | undefined, alias: string): string {
  if (filters?.validAsOf) {
    return `${alias}.superseded_by IS NULL`;
  }

  return buildActiveDurableClause(alias);
}

/**
 * Builds SQL WHERE fragments and bound arguments for recall filters.
 *
 * @param filters - Optional recall filters.
 * @param alias - Table alias used in the query.
 * @returns SQL fragment prefixed with `AND` clauses plus the matching args.
 */
function buildEntryFilterClause(filters: DurableFilters | undefined, alias: string): { sql: string; args: Array<string | number> } {
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
    clauses.push(`EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(${alias}.tags) THEN ${alias}.tags ELSE '[]' END)
      WHERE json_each.value = ?
    )`);
    args.push(tag);
  }

  if (filters.since) {
    clauses.push(`${alias}.created_at >= ?`);
    args.push(filters.since.toISOString());
  }

  if (filters.until) {
    clauses.push(`${alias}.created_at <= ?`);
    args.push(filters.until.toISOString());
  }

  if (filters.validAsOf) {
    clauses.push(buildValidAsOfClause(alias));
    const asOfIso = filters.validAsOf.toISOString();
    args.push(asOfIso, asOfIso);
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

/**
 * Map a ranking-time recall candidate row into the minimal core candidate shape.
 *
 * @param row - Raw libSQL result row.
 * @returns Candidate entry used during ranking.
 */
function mapRecallCandidateRow(row: Row): RecallCandidateDurable {
  const expiry = readRequiredString(row, "expiry");

  return {
    id: readRequiredString(row, "id"),
    subject: readRequiredString(row, "subject"),
    content: readRequiredString(row, "content"),
    importance: readNumber(row, "importance", 0),
    expiry: expiry as RecallCandidateDurable["expiry"],
    embedding: readEmbedding(row, "embedding"),
    superseded_by: readOptionalString(row, "superseded_by"),
    claim_key: readOptionalString(row, "claim_key"),
    claim_key_status: readOptionalClaimKeyStatus(row),
    claim_support_observed_at: readOptionalString(row, "claim_support_observed_at"),
    valid_from: readOptionalString(row, "valid_from"),
    valid_to: readOptionalString(row, "valid_to"),
    created_at: readRequiredString(row, "created_at"),
  };
}

/** Reads one optional claim-key status from a recall candidate row. */
function readOptionalClaimKeyStatus(row: Row): RecallCandidateDurable["claim_key_status"] {
  const value = readOptionalString(row, "claim_key_status");
  if (value === undefined) {
    return undefined;
  }

  const parsed = parseClaimKeyStatus(value);
  if (!parsed) {
    throw new Error(`Invalid lifecycle value ${JSON.stringify(value)} for database column "claim_key_status".`);
  }

  return parsed;
}

/**
 * Resolve the final row budget for one neighborhood expansion call.
 *
 * The budget is the smallest of: the caller-supplied budget, the cap set by
 * the per-seed heuristic, and the adapter-level absolute cap. Falling back
 * to the adapter-level cap protects the database from pathological large
 * seed sets while still honoring the caller when it sets a tighter budget.
 *
 * @param requestedBudget - Budget supplied by the caller.
 * @param seedCount - Normalized seed ID count for this expansion.
 * @returns The final row limit used by the expansion query.
 */
function normalizeNeighborhoodBudget(requestedBudget: number, seedCount: number): number {
  const perSeedCap = seedCount * NEIGHBORHOOD_PER_SEED_BUDGET;
  const safeRequested = Number.isFinite(requestedBudget) && requestedBudget > 0 ? Math.floor(requestedBudget) : perSeedCap;
  return Math.max(1, Math.min(NEIGHBORHOOD_DEFAULT_BUDGET_CAP, perSeedCap, safeRequested));
}

/** Deduplicate and order requested neighborhood families for deterministic SQL. */
function dedupeFamilies(families: readonly NeighborhoodFamily[]): NeighborhoodFamily[] {
  return Array.from(new Set(families));
}

/**
 * Build the SQL CASE expression that prioritizes rows by requested family kind.
 *
 * Lower priorities win. The ordering matches the plan's lineage strength
 * preference: direct supersessions, then trusted same-slot siblings, then
 * untrusted same-slot siblings, then stale same-subject fallbacks.
 */
function buildNeighborhoodPriorityExpression(families: readonly NeighborhoodFamily[], includeHistorical: boolean): string {
  const branches: string[] = [];
  if (families.includes("supersession_chain")) {
    branches.push(`WHEN e.superseded_by IN (SELECT id FROM seed) THEN 0`);
    branches.push(`WHEN e.id IN (SELECT target_id FROM seed_supersessions) THEN 1`);
  }

  if (families.includes("claim_key_sibling")) {
    const historicalOrReplacedGuard = includeHistorical ? buildHistoricalMemoryClause("e") : "e.superseded_by IS NOT NULL";
    branches.push(
      `WHEN e.claim_key IS NOT NULL
         AND e.claim_key IN (SELECT claim_key FROM seed_claim_keys)
         AND e.claim_key_status = 'trusted'
         AND ${historicalOrReplacedGuard} THEN 2`,
    );
    branches.push(
      `WHEN e.claim_key IS NOT NULL
         AND e.claim_key IN (SELECT claim_key FROM seed_claim_keys)
         AND e.claim_key_status = 'trusted' THEN 3`,
    );
    branches.push(
      `WHEN e.claim_key IS NOT NULL
         AND e.claim_key IN (SELECT claim_key FROM seed_claim_keys)
         AND ${historicalOrReplacedGuard} THEN 4`,
    );
    branches.push(
      `WHEN e.claim_key IS NOT NULL
         AND e.claim_key IN (SELECT claim_key FROM seed_claim_keys) THEN 5`,
    );
  }

  if (families.includes("topic_family")) {
    if (includeHistorical) {
      branches.push(`WHEN ${buildStaleMemoryClause("e")} AND e.subject IN (SELECT subject FROM seed_subjects) THEN 6`);
    } else {
      branches.push(`WHEN e.subject IN (SELECT subject FROM seed_subjects) THEN 6`);
    }
  }

  return `CASE ${branches.join("\n              ")} ELSE 9 END`;
}

/** Build the SQL membership disjunction used to admit rows into the neighborhood. */
function buildNeighborhoodMembershipExpression(families: readonly NeighborhoodFamily[]): string {
  const clauses: string[] = [];
  if (families.includes("supersession_chain")) {
    clauses.push(`e.superseded_by IN (SELECT id FROM seed)`);
    clauses.push(`e.id IN (SELECT target_id FROM seed_supersessions)`);
  }

  if (families.includes("claim_key_sibling")) {
    clauses.push(`(e.claim_key IS NOT NULL AND e.claim_key IN (SELECT claim_key FROM seed_claim_keys))`);
  }

  if (families.includes("topic_family")) {
    clauses.push(`e.subject IN (SELECT subject FROM seed_subjects)`);
  }

  return clauses.length === 0 ? "0" : clauses.join("\n              OR ");
}

/** Wraps vector-search failures in a consistent adapter error. */
function wrapVectorError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Vector search is unavailable: ${message}`);
}
