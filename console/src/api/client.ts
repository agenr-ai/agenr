const API_BASE_URL = import.meta.env.VITE_API_URL || "https://api.agenr.ai";

export type ApiError = {
  status: number;
  message: string;
};

export type ApiRawResponse<T> = {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  data: T;
  unauthorizedRedirected: boolean;
};

export type OAuthServiceRecord = {
  service: string;
  name: string;
  platforms?: string[];
};

export type AppCredential = {
  service: string;
  created_at: string;
  updated_at: string;
};

function toUrl(path: string): string {
  if (/^https?:\/\//.test(path)) {
    return path;
  }

  const normalizedBase = API_BASE_URL.replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  return `${normalizedBase}${normalizedPath}`;
}

export function buildApiUrl(path: string): string {
  return toUrl(path);
}

const SESSION_TOKEN_KEY = "agenr.session_token";

export function getSessionToken(): string | null {
  try {
    return window.sessionStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string): void {
  try {
    window.sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    // Storage unavailable
  }
}

export function clearSessionToken(): void {
  try {
    window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // Storage unavailable
  }
}

function buildHeaders(options: RequestInit): Headers {
  const headers = new Headers(options.headers);

  if (!headers.has("Content-Type") && options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  // Inject session token as Bearer auth for cross-origin requests
  const token = getSessionToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return headers;
}

const AUTH_STORAGE_KEYS = [
  "auth",
  "authUser",
  "user",
  "session",
  "agenr.auth",
  "agenr.user",
  "agenr.session",
];

let unauthorizedRedirectInProgress = false;

function normalizePathname(path: string): string {
  if (/^https?:\/\//.test(path)) {
    try {
      return new URL(path).pathname.replace(/\/+$/, "") || "/";
    } catch {
      return path;
    }
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const pathname = normalizedPath.split(/[?#]/, 1)[0] ?? normalizedPath;
  return pathname.replace(/\/+$/, "") || "/";
}

function shouldRedirectForUnauthorized(path: string): boolean {
  return normalizePathname(path) !== "/auth/me";
}

function clearStoredAuthState(): void {
  if (typeof window === "undefined") {
    return;
  }

  clearSessionToken();

  try {
    for (const key of AUTH_STORAGE_KEYS) {
      window.localStorage.removeItem(key);
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Storage access can fail in hardened browser modes; redirect still proceeds.
  }
}

function handleUnauthorized(path: string): boolean {
  if (!shouldRedirectForUnauthorized(path) || typeof window === "undefined") {
    return false;
  }

  if (unauthorizedRedirectInProgress) {
    return true;
  }

  unauthorizedRedirectInProgress = true;
  clearStoredAuthState();
  window.location.href = "/login";
  return true;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  return response.text();
}

export async function apiRawFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<ApiRawResponse<T>> {
  const headers = buildHeaders(options);

  const response = await fetch(toUrl(path), {
    ...options,
    credentials: "include",
    headers,
  });

  const body = await parseResponseBody(response);
  const unauthorizedRedirected = response.status === 401 && handleUnauthorized(path);

  return {
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    headers: response.headers,
    data: body as T,
    unauthorizedRedirected,
  };
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await apiRawFetch<unknown>(path, options);

  if (response.status === 401 && response.unauthorizedRedirected) {
    return new Promise<T>(() => undefined);
  }

  if (!response.ok) {
    const fallback = response.statusText || "Request failed";
    const message =
      typeof response.data === "object" && response.data !== null && "message" in response.data
        ? String((response.data as { message?: unknown }).message ?? fallback)
        : fallback;

    throw {
      status: response.status,
      message,
    } satisfies ApiError;
  }

  return response.data as T;
}

export async function fetchOAuthServices(): Promise<OAuthServiceRecord[]> {
  const response = await apiFetch<{ services?: OAuthServiceRecord[] }>("/connect/services");
  if (!Array.isArray(response.services)) {
    return [];
  }

  return response.services;
}

export async function listAppCredentials(): Promise<AppCredential[]> {
  const response = await apiFetch<AppCredential[]>("/app-credentials");
  return Array.isArray(response) ? response : [];
}

export async function createAppCredential(
  service: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  await apiFetch(`/app-credentials/${encodeURIComponent(service)}`, {
    method: "POST",
    body: JSON.stringify({
      clientId,
      clientSecret,
    }),
  });
}

export async function deleteAppCredential(service: string): Promise<void> {
  await apiFetch(`/app-credentials/${encodeURIComponent(service)}`, {
    method: "DELETE",
  });
}

export interface BusinessRecord {
  id: string;
  ownerId: string;
  name: string;
  platform: string;
  location: string | null;
  description: string | null;
  category: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessConnectionStatus {
  connected: boolean;
  service: string;
  availableServices?: string[];
}

export interface BusinessConnectionRecord {
  service: string;
  authType: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface BusinessConnectionsResponse {
  businessId: string;
  ownerId: string;
  platform: string;
  availableServices: string[];
  connections: BusinessConnectionRecord[];
}

export interface GenerationJobRecord {
  id: string;
  platform: string;
  status: "queued" | "running" | "complete" | "failed";
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface GenerationJobsResponse {
  jobs: GenerationJobRecord[];
  has_more: boolean;
}

export async function fetchBusinesses(): Promise<BusinessRecord[]> {
  const res = await apiFetch<BusinessRecord[]>("/businesses");
  return Array.isArray(res) ? res : [];
}

export async function createBusiness(input: {
  name: string;
  platform: string;
  location?: string;
  description?: string;
  category?: string;
  preferences?: Record<string, unknown>;
}): Promise<BusinessRecord> {
  return apiFetch<BusinessRecord>("/businesses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteBusiness(id: string): Promise<void> {
  await apiFetch(`/businesses/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function fetchBusinessConnectionStatus(
  id: string,
): Promise<BusinessConnectionStatus> {
  return apiFetch<BusinessConnectionStatus>(
    `/businesses/${encodeURIComponent(id)}/connection-status`,
  );
}

export async function fetchBusinessConnections(
  id: string,
): Promise<BusinessConnectionsResponse> {
  return apiFetch<BusinessConnectionsResponse>(
    `/businesses/${encodeURIComponent(id)}/connections`,
  );
}

export async function fetchGenerationJobs(input?: {
  status?: "queued" | "running" | "complete" | "failed";
  limit?: number;
  before?: string;
  beforeId?: string;
}): Promise<GenerationJobsResponse> {
  const params = new URLSearchParams();
  if (input?.status) {
    params.set("status", input.status);
  }
  if (typeof input?.limit === "number" && Number.isInteger(input.limit) && input.limit > 0) {
    params.set("limit", String(input.limit));
  }
  if (input?.before) {
    params.set("before", input.before);
  }
  if (input?.beforeId) {
    params.set("before_id", input.beforeId);
  }

  const query = params.toString();
  const path = query ? `/adapters/jobs?${query}` : "/adapters/jobs";
  return apiFetch<GenerationJobsResponse>(path);
}
