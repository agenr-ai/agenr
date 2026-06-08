import type { DurableKind, Expiry } from "../../core/types.js";
import type { Durable } from "../../core/types.js";
import { buildActiveDurableClause, buildStaleMemoryClause, DURABLE_SELECT_COLUMNS, mapDurableRow } from "./row-mapping.js";
import type { SqlExecutor } from "./queries.js";

/**
 * Lifecycle state filter accepted by the operator durable browser.
 *
 * `active` - current, unsuperseded, within its valid-time window.
 * `stale` - unsuperseded but closed by a passed `valid_to`.
 * `superseded` - replaced by a successor durable.
 * `all` - every stored durable regardless of lifecycle state.
 */
export type WebDurableStateFilter = "active" | "stale" | "superseded" | "all";

/** Ordered list of supported durable browser orderings. */
const WEB_DURABLE_SORT_FIELDS = ["created_at", "updated_at", "importance", "recall_count", "last_recalled_at"] as const;

export { WEB_DURABLE_SORT_FIELDS };

/**
 * Field the operator durable browser sorts on.
 */
export type WebDurableSortField = (typeof WEB_DURABLE_SORT_FIELDS)[number];

/**
 * Structured filter accepted by the operator durable browser.
 *
 * Every field is optional; absent fields impose no constraint. This is a
 * read-only admin query distinct from the ranked recall pipeline, so it
 * supports plain SQL filters (importance, expiry, project, source, state)
 * that recall intentionally folds into ranking instead of `WHERE` clauses.
 */
export interface WebDurableListQuery {
  /** Case-insensitive substring matched against subject and content. */
  text?: string;
  /** Restrict to one or more durable kinds. */
  types?: DurableKind[];
  /** Require every listed tag to be present on the durable. */
  tags?: string[];
  /** Exact project scope match. */
  project?: string;
  /** Lifecycle state filter. Defaults to `active`. */
  state?: WebDurableStateFilter;
  /** Exact canonical claim key match. */
  claimKey?: string;
  /** Claim-key prefix match (`prefix/...`). */
  claimKeyPrefix?: string;
  /** Case-insensitive substring matched against `source_file`. */
  source?: string;
  /** Inclusive minimum importance. */
  minImportance?: number;
  /** Inclusive maximum importance. */
  maxImportance?: number;
  /** Restrict to one expiry tier. */
  expiry?: Expiry;
  /** Only durables created at or after this ISO timestamp. */
  createdSince?: string;
  /** Only durables created at or before this ISO timestamp. */
  createdUntil?: string;
  /** Field to order by. Defaults to `created_at`. */
  sort?: WebDurableSortField;
  /** Sort direction. Defaults to `desc`. */
  direction?: "asc" | "desc";
  /** Maximum rows to return. Defaults to 50. */
  limit?: number;
  /** Rows to skip before returning results. Defaults to 0. */
  offset?: number;
}

/**
 * Paginated durable browser result with the total count for the active filter.
 */
export interface WebDurableListResult {
  /** Durables for the requested page in the requested order. */
  durables: Durable[];
  /** Total durables matching the filter, ignoring pagination. */
  total: number;
  /** Limit applied to this page. */
  limit: number;
  /** Offset applied to this page. */
  offset: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Lists durables for the operator browser using structured admin filters.
 *
 * This is a deliberately separate read path from `recall`: it never ranks or
 * scores, so it can answer "show me every stale preference in project X" or
 * "all durables superseded last week" that the recall pipeline cannot express.
 *
 * @param executor - SQL executor bound to the live or transaction client.
 * @param query - Structured durable filter and pagination request.
 * @returns Paginated durables plus the unpaged total for the same filter.
 */
export async function listWebDurables(executor: SqlExecutor, query: WebDurableListQuery): Promise<WebDurableListResult> {
  const { clause, args } = buildWhereClause(query);
  const limit = clampLimit(query.limit);
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  const sort = resolveSortColumn(query.sort);
  const direction = query.direction === "asc" ? "ASC" : "DESC";

  const countResult = await executor.execute({
    sql: `SELECT COUNT(*) AS total FROM durables ${clause}`,
    args,
  });
  const total = readCount(countResult.rows[0]?.total);

  const listResult = await executor.execute({
    sql: `
      SELECT ${DURABLE_SELECT_COLUMNS}
      FROM durables
      ${clause}
      ORDER BY ${sort} ${direction}, id ${direction}
      LIMIT ? OFFSET ?
    `,
    args: [...args, limit, offset],
  });

  return {
    durables: listResult.rows.map(mapDurableRow),
    total,
    limit,
    offset,
  };
}

/** Builds the parameterized WHERE clause for a durable browser query. */
function buildWhereClause(query: WebDurableListQuery): { clause: string; args: (string | number)[] } {
  const conditions: string[] = [];
  const args: (string | number)[] = [];

  appendStateCondition(query.state ?? "active", conditions);

  const text = query.text?.trim();
  if (text && text.length > 0) {
    conditions.push("(subject LIKE ? OR content LIKE ?)");
    const pattern = `%${text}%`;
    args.push(pattern, pattern);
  }

  if (query.types && query.types.length > 0) {
    conditions.push(`type IN (${query.types.map(() => "?").join(", ")})`);
    args.push(...query.types);
  }

  for (const tag of query.tags ?? []) {
    const normalized = tag.trim();
    if (normalized.length === 0) {
      continue;
    }
    // Tags persist as a JSON array; match the quoted element to avoid substring bleed.
    conditions.push("tags LIKE ?");
    args.push(`%${JSON.stringify(normalized).slice(1, -1)}%`);
  }

  const project = query.project?.trim();
  if (project && project.length > 0) {
    conditions.push("project = ?");
    args.push(project);
  }

  const claimKey = query.claimKey?.trim();
  if (claimKey && claimKey.length > 0) {
    conditions.push("claim_key = ?");
    args.push(claimKey);
  }

  const claimKeyPrefix = query.claimKeyPrefix?.trim();
  if (claimKeyPrefix && claimKeyPrefix.length > 0) {
    conditions.push("claim_key LIKE ?");
    args.push(`${claimKeyPrefix}%`);
  }

  const source = query.source?.trim();
  if (source && source.length > 0) {
    conditions.push("source_file LIKE ?");
    args.push(`%${source}%`);
  }

  if (typeof query.minImportance === "number" && Number.isFinite(query.minImportance)) {
    conditions.push("importance >= ?");
    args.push(query.minImportance);
  }

  if (typeof query.maxImportance === "number" && Number.isFinite(query.maxImportance)) {
    conditions.push("importance <= ?");
    args.push(query.maxImportance);
  }

  if (query.expiry) {
    conditions.push("expiry = ?");
    args.push(query.expiry);
  }

  const createdSince = query.createdSince?.trim();
  if (createdSince && createdSince.length > 0) {
    conditions.push("datetime(created_at) >= datetime(?)");
    args.push(createdSince);
  }

  const createdUntil = query.createdUntil?.trim();
  if (createdUntil && createdUntil.length > 0) {
    conditions.push("datetime(created_at) <= datetime(?)");
    args.push(createdUntil);
  }

  const clause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { clause, args };
}

/** Appends the lifecycle-state predicate for the requested filter. */
function appendStateCondition(state: WebDurableStateFilter, conditions: string[]): void {
  if (state === "active") {
    conditions.push(buildActiveDurableClause());
    return;
  }

  if (state === "stale") {
    conditions.push(buildStaleMemoryClause());
    return;
  }

  if (state === "superseded") {
    conditions.push("superseded_by IS NOT NULL");
  }
}

/** Resolves the validated sort column to interpolate into the query. */
function resolveSortColumn(sort: WebDurableSortField | undefined): WebDurableSortField {
  return sort && WEB_DURABLE_SORT_FIELDS.includes(sort) ? sort : "created_at";
}

/** Clamps the requested page size into the supported range. */
function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/** Reads a numeric count from a libSQL aggregate cell. */
function readCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}
