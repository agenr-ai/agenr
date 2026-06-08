import type {
  ApiErrorBody,
  CockpitSnapshot,
  DreamJobSnapshot,
  DreamProposal,
  DreamRunsResponse,
  DurableListResult,
  DurableTrace,
  EpisodeListResult,
  InstancesResponse,
  MemoryFacets,
  Procedure,
  ProcedureDocument,
  ProcedureSaveResult,
  ProcedureSyncPlan,
  ProcedureValidation,
  ProcedureWorkspace,
  ProposalBacklogItem,
  ProposalDetail,
  SelectedInstanceResponse,
  StoreDurableBody,
  UpdateDurableMetadataBody,
} from "./types";

/** Error thrown for non-2xx API responses, carrying the structured envelope. */
export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: { path: string; message: string }[];

  /**
   * Creates an API error from a status code and parsed envelope.
   *
   * @param status - HTTP status code.
   * @param body - Parsed error envelope, when available.
   */
  public constructor(status: number, body: ApiErrorBody | null) {
    super(body?.error.message ?? `Request failed with status ${status}.`);
    this.name = "ApiError";
    this.status = status;
    this.code = body?.error.code ?? "unknown";
    if (body?.error.details) {
      this.details = body.error.details;
    }
  }
}

/** Performs a JSON request and unwraps the response or throws an ApiError. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const envelope = await safeJson<ApiErrorBody>(response);
    throw new ApiError(response.status, envelope);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

/** Parses a response body as JSON, swallowing parse failures. */
async function safeJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Builds a query string from a record, dropping empty values. */
function query(params: Record<string, string | number | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > 0) {
        search.set(key, value.join(","));
      }
      continue;
    }
    const text = String(value).trim();
    if (text.length > 0) {
      search.set(key, text);
    }
  }
  const text = search.toString();
  return text.length > 0 ? `?${text}` : "";
}

/** Filter inputs accepted by the durable list endpoint. */
export interface DurableQueryInput {
  text?: string;
  types?: string[];
  tags?: string[];
  project?: string;
  state?: string;
  claimKey?: string;
  claimKeyPrefix?: string;
  source?: string;
  minImportance?: number;
  maxImportance?: number;
  expiry?: string;
  sort?: string;
  direction?: string;
  limit?: number;
  offset?: number;
}

/** Typed client for the agenr operator console API. */
export const api = {
  /** Lists registered instances and the current selection. */
  listInstances: () => request<InstancesResponse>("GET", "/api/web/instances"),
  /** Returns the currently selected resolved instance. */
  selectedInstance: () => request<SelectedInstanceResponse>("GET", "/api/web/instance"),
  /** Registers and selects a new instance. */
  registerInstance: (input: { name: string; configPath?: string; dbPath?: string; proceduresDir?: string }) =>
    request<InstancesResponse>("POST", "/api/web/instances", input),
  /** Selects an existing instance. */
  selectInstance: (id: string) => request<{ selected: InstancesResponse["instances"][number] }>("POST", `/api/web/instances/${encodeURIComponent(id)}/select`),
  /** Removes an instance from the registry. */
  removeInstance: (id: string) => request<InstancesResponse>("DELETE", `/api/web/instances/${encodeURIComponent(id)}`),

  /** Loads the aggregate ops cockpit snapshot. */
  cockpit: () => request<CockpitSnapshot>("GET", "/api/web/cockpit"),

  /** Lists persisted run history plus live jobs. */
  dreamRuns: () => request<DreamRunsResponse>("GET", "/api/web/dream/runs"),
  /** Starts a dreaming run, returning the initial job snapshot. */
  startDream: (input: { tier: string; apply: boolean; project?: string }) => request<DreamJobSnapshot>("POST", "/api/web/dream/runs", input),
  /** Reads one live job snapshot. */
  dreamJob: (jobId: string) => request<DreamJobSnapshot>("GET", `/api/web/dream/jobs/${encodeURIComponent(jobId)}`),
  /** Requests cancellation of one job. */
  cancelDream: (jobId: string) => request<{ cancelled: boolean }>("POST", `/api/web/dream/jobs/${encodeURIComponent(jobId)}/cancel`),
  /** Loads the action trail for one persisted run. */
  runActions: (runId: string) => request<{ actions: { id: string; actionType: string; reasoning: string; createdAt: string }[] }>(
    "GET",
    `/api/web/dream/runs/${encodeURIComponent(runId)}/actions`,
  ),
  /** Loads the proposal trail for one persisted run. */
  runProposals: (runId: string) => request<{ proposals: DreamProposal[] }>("GET", `/api/web/dream/runs/${encodeURIComponent(runId)}/proposals`),

  /** Lists the proposal backlog with filters. */
  proposals: (params: { limit?: number; minConfidence?: number; createdSince?: string; includeIneligible?: boolean }) =>
    request<{ backlog: ProposalBacklogItem[] }>(
      "GET",
      `/api/web/proposals${query({
        limit: params.limit,
        minConfidence: params.minConfidence,
        createdSince: params.createdSince,
        includeIneligible: params.includeIneligible ? "true" : undefined,
      })}`,
    ),
  /** Loads one proposal with hydrated durables. */
  proposalDetail: (id: string) => request<ProposalDetail>("GET", `/api/web/proposals/${encodeURIComponent(id)}`),
  /** Applies or rejects one proposal. */
  reviewProposal: (id: string, input: { decision: "apply" | "reject"; reason: string }) =>
    request<{ proposal: DreamProposal }>("POST", `/api/web/proposals/${encodeURIComponent(id)}/review`, input),

  /** Lists durables with structured filters. */
  durables: (input: DurableQueryInput) => request<DurableListResult>("GET", `/api/web/durables${query({ ...input })}`),
  /** Loads one durable trace. */
  durable: (id: string) => request<DurableTrace>("GET", `/api/web/durables/${encodeURIComponent(id)}`),
  /** Stores a new durable. */
  storeDurable: (input: StoreDurableBody) => request<{ durableId: string | null }>("POST", "/api/web/durables", input),
  /** Supersedes the named durable with a successor. */
  supersedeDurable: (id: string, input: StoreDurableBody) =>
    request<{ durableId: string | null; backupPath: string | null }>("POST", `/api/web/durables/${encodeURIComponent(id)}/supersede`, input),
  /** Updates metadata-only fields on a durable. */
  updateDurable: (id: string, input: UpdateDurableMetadataBody) =>
    request<{ updated: boolean; backupPath: string | null }>("POST", `/api/web/durables/${encodeURIComponent(id)}/metadata`, input),
  /** Retires a durable by closing its valid-time window. */
  retireDurable: (id: string, reason?: string) =>
    request<{ updated: boolean; backupPath: string | null }>("POST", `/api/web/durables/${encodeURIComponent(id)}/retire`, reason ? { reason } : {}),
  /** Loads memory explorer filter facets. */
  memoryFacets: () => request<MemoryFacets>("GET", "/api/web/memory/facets"),

  /** Lists recent episodes. */
  episodes: (params: { project?: string; limit?: number; offset?: number }) =>
    request<EpisodeListResult>("GET", `/api/web/episodes${query({ ...params })}`),
  /** Lists active procedures (read side). */
  procedures: () => request<{ procedures: Procedure[] }>("GET", "/api/web/procedures"),

  /** Loads the procedure editor workspace. */
  procedureWorkspace: () => request<ProcedureWorkspace>("GET", "/api/web/procedure-files"),
  /** Reads one procedure document. */
  procedureDocument: (relativePath: string) =>
    request<ProcedureDocument>("GET", `/api/web/procedure-files/content${query({ path: relativePath })}`),
  /** Validates posted YAML content. */
  validateProcedure: (content: string, relativePath?: string) =>
    request<ProcedureValidation>("POST", "/api/web/procedure-files/validate", { content, relativePath }),
  /** Saves a procedure document and syncs it. */
  saveProcedure: (input: { relativePath: string; content: string }) => request<ProcedureSaveResult>("PUT", "/api/web/procedure-files", input),
  /** Previews a procedure sync plan. */
  previewSync: () => request<{ plan: ProcedureSyncPlan; git: ProcedureWorkspace["git"] }>("GET", "/api/web/procedure-sync/preview"),
};

/** Builds the SSE URL for a dreaming job stream. */
export function dreamStreamUrl(jobId: string): string {
  return `/api/web/dream/jobs/${encodeURIComponent(jobId)}/stream`;
}
