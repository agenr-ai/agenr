import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import {
  apiFetch,
  apiRawFetch,
  fetchOAuthServices,
  type ApiError,
  type OAuthServiceRecord,
} from "../api/client";
import DataTable, { type Column } from "../components/DataTable";
import { relativeTime } from "../utils/time";

type ConnectionStatus = "connected" | "expired";
type ManualAuthType = "bearer" | "api_key" | "client_credentials" | "cookie" | "basic";

interface CredentialRecord {
  service: string;
  auth_type: string;
  connected_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  status: ConnectionStatus;
}

interface AdapterOption {
  platform: string;
  meta?: {
    name?: string;
    description?: string;
  };
}

interface ConnectCredentialResponse {
  status: "connected";
  service: string;
}

interface DisconnectCredentialResponse {
  status: "disconnected";
  service: string;
}

interface AuditActivityEntry {
  id: string;
  timestamp: string;
  action: string;
  execution_id: string | null;
  metadata: Record<string, unknown> | null;
}

interface ActivityResponse {
  service: string;
  entries: AuditActivityEntry[];
  has_more: boolean;
}

interface ServiceActivityState {
  entries: AuditActivityEntry[];
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  expanded: boolean;
  error: string | null;
}

type ManualCredentialPayload =
  | {
      auth_type: "api_key";
      api_key: string;
    }
  | {
      auth_type: "client_credentials";
      client_id: string;
      client_secret: string;
    }
  | {
      auth_type: "cookie";
      cookie_name: string;
      cookie_value: string;
    }
  | {
      auth_type: "basic";
      username: string;
      password: string;
    };

const API_BASE_URL = (import.meta.env.VITE_API_URL || "https://api.agenr.ai").replace(/\/$/, "");
const ACTIVITY_PAGE_SIZE = 20;

function isApiError(error: unknown): error is ApiError {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
  );
}

function toApiErrorMessage(error: unknown, fallback: string): string {
  if (isApiError(error)) {
    const detail = error.message?.trim();

    if (error.status === 400) {
      return detail || "Validation failed. Check your inputs and try again.";
    }
    if (error.status === 404) {
      return detail || "Service not found.";
    }
    if (error.status >= 500) {
      return detail || "Server error. Try again in a moment.";
    }

    return detail || fallback;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

function toServiceLabel(service: string): string {
  return service
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function toAuthTypeLabel(authType: string): string {
  if (authType === "oauth2") {
    return "OAuth2";
  }
  if (authType === "api_key") {
    return "API Key";
  }
  if (authType === "cookie") {
    return "Cookie";
  }
  if (authType === "basic") {
    return "Basic";
  }
  if (authType === "client_credentials") {
    return "Client Credentials";
  }

  return authType;
}

function statusBadgeClasses(status: ConnectionStatus): string {
  if (status === "expired") {
    return "border-red-300 dark:border-red-400/30 bg-red-50 dark:bg-red-500/20 text-red-700 dark:text-red-200";
  }

  return "border-emerald-300 dark:border-emerald-400/30 bg-emerald-50 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200";
}

function tryMessageFromUnknown(data: unknown, fallback: string): string {
  if (typeof data === "object" && data !== null && "message" in data) {
    const value = (data as { message?: unknown }).message;
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return fallback;
}

function toActivityActionLabel(action: string): string {
  if (action === "credential_retrieved") {
    return "Credential accessed";
  }
  if (action === "credential_stored") {
    return "Credential stored";
  }
  if (action === "credential_deleted") {
    return "Credential deleted";
  }
  if (action === "credential_rotated") {
    return "Credential rotated";
  }
  if (action === "connection_initiated") {
    return "Connection started";
  }
  if (action === "connection_completed") {
    return "Connection completed";
  }
  if (action === "connection_failed") {
    return "Connection failed";
  }
  if (action === "dek_generated") {
    return "Encryption key generated";
  }
  if (action === "dek_unwrapped") {
    return "Encryption key accessed";
  }

  return toServiceLabel(action);
}

function readMetadataValue(metadata: Record<string, unknown> | null, key: "domain" | "adapter"): string | null {
  if (!metadata || !(key in metadata)) {
    return null;
  }

  const value = metadata[key];
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
}

function createDefaultServiceActivityState(): ServiceActivityState {
  return {
    entries: [],
    hasMore: false,
    loaded: false,
    loading: false,
    loadingMore: false,
    expanded: false,
    error: null,
  };
}

const activityColumns: Column<AuditActivityEntry>[] = [
  {
    key: "action",
    header: "Action",
    className: "font-semibold text-app-text",
    render: (entry) => toActivityActionLabel(entry.action),
  },
  {
    key: "time",
    header: "Time",
    className: "whitespace-nowrap text-app-text-subtle",
    render: (entry) => relativeTime(entry.timestamp),
  },
  {
    key: "details",
    header: "Details",
    render: (entry) => {
      const domain = readMetadataValue(entry.metadata, "domain");
      const adapter = readMetadataValue(entry.metadata, "adapter");
      const parts: string[] = [];

      if (domain) {
        parts.push(`Domain: ${domain}`);
      }
      if (adapter) {
        parts.push(`Adapter: ${adapter}`);
      }

      return parts.length > 0 ? parts.join(" · ") : "—";
    },
  },
];

export default function Connections() {
  const [searchParams, setSearchParams] = useSearchParams();
  const formRef = useRef<HTMLElement>(null);

  const [connections, setConnections] = useState<CredentialRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adaptersError, setAdaptersError] = useState<string | null>(null);
  const [deletingService, setDeletingService] = useState<string | null>(null);
  const [adapters, setAdapters] = useState<AdapterOption[]>([]);
  const [isAdaptersLoading, setIsAdaptersLoading] = useState(true);
  const [oauthServices, setOauthServices] = useState<OAuthServiceRecord[]>([]);
  const [preselectedService, setPreselectedService] = useState<string | null>(null);

  const [service, setService] = useState("");
  const [authType, setAuthType] = useState<ManualAuthType>("bearer");
  const [bearerToken, setBearerToken] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [cookieName, setCookieName] = useState("");
  const [cookieValue, setCookieValue] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [showOauthHint, setShowOauthHint] = useState(false);
  const [activityByService, setActivityByService] = useState<Record<string, ServiceActivityState>>({});
  const oauthServiceSet = useMemo(
    () => new Set(oauthServices.map((service) => service.service.trim().toLowerCase())),
    [oauthServices],
  );
  const defaultAuthType = useCallback(
    (platform: string): ManualAuthType => {
      if (oauthServiceSet.has(platform.trim().toLowerCase())) {
        return "bearer";
      }

      return "api_key";
    },
    [oauthServiceSet],
  );

  const fetchConnections = useCallback(async (background = false) => {
    if (background) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }
    setLoadError(null);

    try {
      const data = await apiFetch<CredentialRecord[]>("/credentials");
      const sorted = [...data].sort((left, right) => left.service.localeCompare(right.service));
      setConnections(sorted);
    } catch (error) {
      setLoadError(toApiErrorMessage(error, "Unable to load connections right now."));
    } finally {
      if (background) {
        setIsRefreshing(false);
      } else {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const serviceFromQuery = searchParams.get("service");
    if (!serviceFromQuery) {
      return;
    }

    const normalized = serviceFromQuery.trim();
    if (normalized) {
      setPreselectedService(normalized);
      setService(normalized);
      setAuthType(defaultAuthType(normalized));
    }

    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  const fetchAdapters = useCallback(async () => {
    setIsAdaptersLoading(true);
    setAdaptersError(null);

    try {
      const data = await apiFetch<AdapterOption[]>("/adapters");
      const sorted = [...data].sort((left, right) => left.platform.localeCompare(right.platform));
      setAdapters(sorted);
    } catch (error) {
      setAdaptersError(toApiErrorMessage(error, "Unable to load adapters right now."));
    } finally {
      setIsAdaptersLoading(false);
    }
  }, []);

  const fetchAvailableOAuthServices = useCallback(async () => {
    try {
      const services = await fetchOAuthServices();
      const sorted = [...services].sort((left, right) => left.name.localeCompare(right.name));
      setOauthServices(sorted);
    } catch {
      setOauthServices([]);
    }
  }, []);

  useEffect(() => {
    void fetchConnections();
    void fetchAdapters();
    void fetchAvailableOAuthServices();
  }, [fetchAdapters, fetchAvailableOAuthServices, fetchConnections]);

  useEffect(() => {
    if (!service.trim()) {
      return;
    }

    setAuthType((current) => {
      if (current !== "bearer" && current !== "api_key") {
        return current;
      }

      return defaultAuthType(service);
    });
  }, [defaultAuthType, service]);

  useEffect(() => {
    if (!preselectedService || !formRef.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);

    return () => {
      window.clearTimeout(timer);
    };
  }, [preselectedService]);

  const loadInitialActivity = useCallback(
    async (serviceName: string) => {
      const current = activityByService[serviceName];
      if (current?.loading || current?.loadingMore) {
        return;
      }

      setActivityByService((previous) => {
        const existing = previous[serviceName] ?? createDefaultServiceActivityState();
        return {
          ...previous,
          [serviceName]: {
            ...existing,
            expanded: true,
            loading: true,
            error: null,
          },
        };
      });

      try {
        const response = await apiFetch<ActivityResponse>(
          `/credentials/${encodeURIComponent(serviceName)}/activity?limit=${ACTIVITY_PAGE_SIZE}`,
        );

        setActivityByService((previous) => {
          const existing = previous[serviceName] ?? createDefaultServiceActivityState();
          return {
            ...previous,
            [serviceName]: {
              ...existing,
              entries: response.entries,
              hasMore: response.has_more,
              loaded: true,
              loading: false,
              loadingMore: false,
              expanded: true,
              error: null,
            },
          };
        });
      } catch (error) {
        setActivityByService((previous) => {
          const existing = previous[serviceName] ?? createDefaultServiceActivityState();
          return {
            ...previous,
            [serviceName]: {
              ...existing,
              loaded: true,
              loading: false,
              loadingMore: false,
              expanded: true,
              error: toApiErrorMessage(error, "Unable to load activity right now."),
            },
          };
        });
      }
    },
    [activityByService],
  );

  const loadMoreActivity = useCallback(
    async (serviceName: string) => {
      const current = activityByService[serviceName];
      if (!current || current.loading || current.loadingMore || !current.hasMore) {
        return;
      }

      const lastEntry = current.entries[current.entries.length - 1];
      if (!lastEntry) {
        return;
      }

      setActivityByService((previous) => {
        const existing = previous[serviceName] ?? createDefaultServiceActivityState();
        return {
          ...previous,
          [serviceName]: {
            ...existing,
            loadingMore: true,
            error: null,
          },
        };
      });

      try {
        const response = await apiFetch<ActivityResponse>(
          `/credentials/${encodeURIComponent(serviceName)}/activity?limit=${ACTIVITY_PAGE_SIZE}&before=${encodeURIComponent(lastEntry.timestamp)}`,
        );

        setActivityByService((previous) => {
          const existing = previous[serviceName] ?? createDefaultServiceActivityState();
          return {
            ...previous,
            [serviceName]: {
              ...existing,
              entries: [...existing.entries, ...response.entries],
              hasMore: response.has_more,
              loaded: true,
              loadingMore: false,
              error: null,
            },
          };
        });
      } catch (error) {
        setActivityByService((previous) => {
          const existing = previous[serviceName] ?? createDefaultServiceActivityState();
          return {
            ...previous,
            [serviceName]: {
              ...existing,
              loadingMore: false,
              error: toApiErrorMessage(error, "Unable to load more activity."),
            },
          };
        });
      }
    },
    [activityByService],
  );

  const toggleActivity = useCallback(
    async (serviceName: string) => {
      const current = activityByService[serviceName];
      const nextExpanded = !(current?.expanded ?? false);

      if (!nextExpanded) {
        setActivityByService((previous) => {
          const existing = previous[serviceName] ?? createDefaultServiceActivityState();
          return {
            ...previous,
            [serviceName]: {
              ...existing,
              expanded: false,
            },
          };
        });
        return;
      }

      setActivityByService((previous) => {
        const existing = previous[serviceName] ?? createDefaultServiceActivityState();
        return {
          ...previous,
          [serviceName]: {
            ...existing,
            expanded: true,
          },
        };
      });

      if (!current?.loaded) {
        await loadInitialActivity(serviceName);
      }
    },
    [activityByService, loadInitialActivity],
  );

  async function handleDisconnect(connection: CredentialRecord) {
    const confirmed = window.confirm(
      `Disconnect from ${connection.service}? This will delete your stored credentials.`,
    );
    if (!confirmed) {
      return;
    }

    setDeletingService(connection.service);
    setLoadError(null);

    try {
      const response = await apiRawFetch<DisconnectCredentialResponse | { message?: string }>(
        `/credentials/${encodeURIComponent(connection.service)}`,
        {
          method: "DELETE",
        },
      );

      if (!response.ok) {
        if (response.status === 401 && response.unauthorizedRedirected) {
          return;
        }
        throw {
          status: response.status,
          message: tryMessageFromUnknown(response.data, response.statusText || "Request failed"),
        } satisfies ApiError;
      }

      await fetchConnections(true);
      setActivityByService((previous) => {
        if (!(connection.service in previous)) {
          return previous;
        }

        const next = { ...previous };
        delete next[connection.service];
        return next;
      });
    } catch (error) {
      setLoadError(toApiErrorMessage(error, "Unable to disconnect this service."));
    } finally {
      setDeletingService(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);
    setSubmitSuccess(null);

    const trimmedService = service.trim();

    if (!trimmedService) {
      setSubmitError("Service selection is required.");
      return;
    }

    let payload: ManualCredentialPayload;

    if (authType === "bearer") {
      const trimmedToken = bearerToken.trim();
      if (!trimmedToken) {
        setSubmitError("Bearer token is required.");
        return;
      }
      payload = {
        auth_type: "api_key",
        api_key: trimmedToken,
      };
    } else if (authType === "api_key") {
      const trimmedApiKey = apiKey.trim();
      if (!trimmedApiKey) {
        setSubmitError("API key is required.");
        return;
      }
      payload = {
        auth_type: "api_key",
        api_key: trimmedApiKey,
      };
    } else if (authType === "client_credentials") {
      const trimmedClientId = clientId.trim();
      const trimmedClientSecret = clientSecret.trim();
      if (!trimmedClientId || !trimmedClientSecret) {
        setSubmitError("Client ID and client secret are required.");
        return;
      }

      payload = {
        auth_type: "client_credentials",
        client_id: trimmedClientId,
        client_secret: trimmedClientSecret,
      };
    } else if (authType === "cookie") {
      const trimmedCookieName = cookieName.trim();
      const trimmedCookieValue = cookieValue.trim();

      if (!trimmedCookieName || !trimmedCookieValue) {
        setSubmitError("Cookie name and cookie value are required.");
        return;
      }

      payload = {
        auth_type: "cookie",
        cookie_name: trimmedCookieName,
        cookie_value: trimmedCookieValue,
      };
    } else {
      const trimmedUsername = username.trim();
      if (!trimmedUsername || !password) {
        setSubmitError("Username and password are required.");
        return;
      }

      payload = {
        auth_type: "basic",
        username: trimmedUsername,
        password,
      };
    }

    setIsSubmitting(true);

    try {
      const response = await apiFetch<ConnectCredentialResponse>(`/credentials/${encodeURIComponent(trimmedService)}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      setSubmitSuccess(`Connected ${toServiceLabel(response.service)}.`);
      setService("");
      setPreselectedService(null);
      setBearerToken("");
      setApiKey("");
      setClientId("");
      setClientSecret("");
      setCookieName("");
      setCookieValue("");
      setUsername("");
      setPassword("");
      await fetchConnections(true);
    } catch (error) {
      setSubmitError(toApiErrorMessage(error, "Unable to connect credential."));
    } finally {
      setIsSubmitting(false);
    }
  }

  function openOAuth(serviceName: string) {
    const oauthUrl = `${API_BASE_URL}/connect/${encodeURIComponent(serviceName)}`;
    window.open(oauthUrl, "_blank", "noopener,noreferrer");
    setShowOauthHint(true);
  }

  const isRefreshDisabled = isLoading || isRefreshing;
  const availableAdapters = adapters.filter((adapter) => {
    return !connections.some((connection) => connection.service === adapter.platform);
  });
  const unconnectedOauthServices = oauthServices.filter(
    (oauthService) =>
      !connections.some(
        (connection) => connection.service.toLowerCase() === oauthService.service.toLowerCase(),
      ),
  );
  const visibleOauthServices = unconnectedOauthServices;
  const selectedAdapter = adapters.find((adapter) => adapter.platform === service);
  const selectedServiceLabel = selectedAdapter?.meta?.name ?? toServiceLabel(service);
  const isPreselectedServiceAlreadyConnected = Boolean(
    preselectedService &&
      service === preselectedService &&
      connections.some((connection) => connection.service === preselectedService),
  );

  return (
    <section className="space-y-8">
      <div>
        <h1 className="text-3xl font-semibold text-app-text">Connections</h1>
        <p className="mt-2 text-app-text-subtle">Manage OAuth and manual credentials for your connected services.</p>
      </div>

      <section className="rounded-2xl border border-app-border bg-app-surface p-6 shadow-xl shadow-black/30">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-app-text">Connected Services</h2>
          <button
            type="button"
            onClick={() => {
              void fetchConnections(true);
              void fetchAvailableOAuthServices();
            }}
            disabled={isRefreshDisabled}
            className="rounded-lg border border-app-border-strong px-3 py-2 text-sm font-medium text-app-text-muted transition hover:border-blue-400 dark:hover:border-blue-400/60 hover:text-blue-700 dark:hover:text-blue-200 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {loadError ? (
          <div className="mt-4 rounded-lg border border-red-300 dark:border-red-400/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">
            {loadError}
          </div>
        ) : null}

        {isLoading ? (
          <p className="mt-4 text-sm text-app-text-subtle">Loading connections...</p>
        ) : connections.length === 0 ? (
          <p className="mt-4 text-sm text-app-text-subtle">No connections yet.</p>
        ) : (
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {connections.map((connection) => {
              const isDeleting = deletingService === connection.service;
              const activityState = activityByService[connection.service] ?? createDefaultServiceActivityState();

              return (
                <article key={`${connection.service}:${connection.auth_type}`} className="rounded-xl border border-app-border bg-app-surface-soft p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-base font-semibold text-app-text">{toServiceLabel(connection.service)}</p>
                    <span className="inline-flex rounded-full border border-blue-300 dark:border-blue-400/30 bg-blue-50 dark:bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-200">
                      {toAuthTypeLabel(connection.auth_type)}
                    </span>
                    <span
                      className={[
                        "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium",
                        statusBadgeClasses(connection.status),
                      ].join(" ")}
                    >
                      {connection.status === "expired" ? "Expired" : "Connected"}
                    </span>
                  </div>

                  <div className="mt-3 space-y-1 text-sm text-app-text-subtle">
                    <p>Connected {relativeTime(connection.connected_at)}</p>
                    {connection.last_used_at ? <p>Last used {relativeTime(connection.last_used_at)}</p> : null}
                    {connection.expires_at ? <p>Expires {relativeTime(connection.expires_at)}</p> : null}
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void toggleActivity(connection.service)}
                      disabled={activityState.loading}
                      className="rounded-lg border border-app-border-strong px-3 py-2 text-xs font-medium text-app-text-muted transition hover:border-blue-400 dark:hover:border-blue-400/60 hover:text-blue-700 dark:hover:text-blue-200 disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      {activityState.expanded ? "Hide Activity" : "View Activity"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDisconnect(connection)}
                      disabled={isDeleting}
                      className="rounded-lg border border-red-300 dark:border-red-400/30 px-3 py-2 text-xs font-medium text-red-700 dark:text-red-300 transition hover:bg-red-100 dark:hover:bg-red-500/20 hover:text-red-700 dark:hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      {isDeleting ? "Disconnecting..." : "Disconnect"}
                    </button>
                  </div>

                  {activityState.expanded ? (
                    <div className="mt-4">
                      <DataTable
                        columns={activityColumns}
                        rows={activityState.entries}
                        rowKey={(entry) => entry.id}
                        loading={activityState.loading && !activityState.loaded}
                        loadingMessage="Loading activity..."
                        emptyMessage="No activity recorded yet."
                        error={activityState.error}
                        hasMore={activityState.hasMore}
                        loadingMore={activityState.loadingMore}
                        onLoadMore={() => void loadMoreActivity(connection.service)}
                        loadMoreLabel="Load More"
                      />
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section ref={formRef} className="rounded-2xl border border-app-border bg-app-surface p-6 shadow-xl shadow-black/30">
        <h2 className="text-xl font-semibold text-app-text">Add Credential</h2>
        <p className="mt-2 text-sm text-app-text-subtle">
          Connect a service using bearer token, API key, client credentials, cookie, or username/password.
        </p>

        {adaptersError ? (
          <div className="mt-4 rounded-lg border border-red-300 dark:border-red-400/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">
            {adaptersError}
          </div>
        ) : null}
        {submitSuccess ? (
          <div className="mt-4 rounded-lg border border-emerald-300 dark:border-emerald-400/30 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-200">
            {submitSuccess}
          </div>
        ) : null}
        {submitError ? (
          <div className="mt-4 rounded-lg border border-red-300 dark:border-red-400/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">
            {submitError}
          </div>
        ) : null}

        {isPreselectedServiceAlreadyConnected ? (
          <div className="mt-4 rounded-lg border border-yellow-300 dark:border-yellow-400/30 bg-yellow-50 dark:bg-yellow-500/10 px-3 py-2 text-sm text-yellow-800 dark:text-yellow-100">
            <p>Already connected to {selectedServiceLabel}.</p>
            <button
              type="button"
              onClick={() => {
                setPreselectedService(null);
                setService("");
              }}
              className="mt-2 rounded-lg border border-app-border-strong px-3 py-1.5 text-xs font-medium text-app-text-muted transition hover:border-blue-400 dark:hover:border-blue-400/60 hover:text-blue-700 dark:hover:text-blue-200"
            >
              Connect another adapter
            </button>
          </div>
        ) : (
          <form className="mt-4 grid gap-4" onSubmit={(event) => void handleSubmit(event)}>
            <div>
              <label htmlFor="service" className="mb-2 block text-sm font-medium text-app-text-muted">
                Service
              </label>
              <select
                id="service"
                name="service"
                value={service}
                onChange={(event) => {
                  const nextService = event.target.value;
                  setService(nextService);
                  if (nextService) {
                    setAuthType(defaultAuthType(nextService));
                  }
                }}
                disabled={isSubmitting || isAdaptersLoading || availableAdapters.length === 0}
                required
                className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-70"
              >
                <option value="">
                  {isAdaptersLoading
                    ? "Loading adapters..."
                    : availableAdapters.length === 0
                      ? "No adapters available"
                      : "Select an adapter..."}
                </option>
                {availableAdapters.map((adapter) => (
                  <option key={adapter.platform} value={adapter.platform}>
                    {adapter.meta?.name ?? adapter.platform}
                  </option>
                ))}
              </select>
            </div>

            {availableAdapters.length === 0 && !isAdaptersLoading ? (
              <p className="text-sm text-app-text-subtle">All available adapters are already connected.</p>
            ) : null}

            <div>
              <label htmlFor="authType" className="mb-2 block text-sm font-medium text-app-text-muted">
                Auth type
              </label>
              <select
                id="authType"
                name="authType"
                value={authType}
                onChange={(event) => setAuthType(event.target.value as ManualAuthType)}
                disabled={isSubmitting}
                className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-70"
              >
                <option value="bearer">Bearer Token</option>
                <option value="api_key">API Key</option>
                <option value="client_credentials">Client Credentials</option>
                <option value="cookie">Cookie</option>
                <option value="basic">Basic Auth</option>
              </select>
            </div>

            {authType === "bearer" ? (
              <div>
                <label htmlFor="bearerToken" className="mb-2 block text-sm font-medium text-app-text-muted">
                  Bearer Token
                </label>
                <input
                  id="bearerToken"
                  name="bearerToken"
                  type="password"
                  value={bearerToken}
                  onChange={(event) => setBearerToken(event.target.value)}
                  disabled={isSubmitting}
                  required
                  className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-70"
                />
              </div>
            ) : null}

            {authType === "api_key" ? (
              <div>
                <label htmlFor="apiKey" className="mb-2 block text-sm font-medium text-app-text-muted">
                  API Key
                </label>
                <input
                  id="apiKey"
                  name="apiKey"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  disabled={isSubmitting}
                  required
                  className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-70"
                />
              </div>
            ) : null}

            {authType === "client_credentials" ? (
              <>
                <div>
                  <label htmlFor="clientId" className="mb-2 block text-sm font-medium text-app-text-muted">
                    Client ID
                  </label>
                  <input
                    id="clientId"
                    name="clientId"
                    type="password"
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                    disabled={isSubmitting}
                    required
                    className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </div>
                <div>
                  <label htmlFor="clientSecret" className="mb-2 block text-sm font-medium text-app-text-muted">
                    Client Secret
                  </label>
                  <input
                    id="clientSecret"
                    name="clientSecret"
                    type="password"
                    value={clientSecret}
                    onChange={(event) => setClientSecret(event.target.value)}
                    disabled={isSubmitting}
                    required
                    className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </div>
              </>
            ) : null}

            {authType === "cookie" ? (
              <>
                <div>
                  <label htmlFor="cookieName" className="mb-2 block text-sm font-medium text-app-text-muted">
                    Cookie Name
                  </label>
                  <input
                    id="cookieName"
                    name="cookieName"
                    type="text"
                    value={cookieName}
                    onChange={(event) => setCookieName(event.target.value)}
                    disabled={isSubmitting}
                    required
                    className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </div>
                <div>
                  <label htmlFor="cookieValue" className="mb-2 block text-sm font-medium text-app-text-muted">
                    Cookie Value
                  </label>
                  <input
                    id="cookieValue"
                    name="cookieValue"
                    type="password"
                    value={cookieValue}
                    onChange={(event) => setCookieValue(event.target.value)}
                    disabled={isSubmitting}
                    required
                    className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </div>
              </>
            ) : null}

            {authType === "basic" ? (
              <>
                <div>
                  <label htmlFor="username" className="mb-2 block text-sm font-medium text-app-text-muted">
                    Username
                  </label>
                  <input
                    id="username"
                    name="username"
                    type="text"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    disabled={isSubmitting}
                    required
                    className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </div>
                <div>
                  <label htmlFor="password" className="mb-2 block text-sm font-medium text-app-text-muted">
                    Password
                  </label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={isSubmitting}
                    required
                    className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </div>
              </>
            ) : null}

            <div>
              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400/50 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting ? "Connecting..." : "Connect"}
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="rounded-2xl border border-app-border bg-app-surface p-6 shadow-xl shadow-black/30">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-app-text">OAuth Services</h2>
            <p className="mt-2 text-sm text-app-text-subtle">Connect to services that support OAuth authorization.</p>
          </div>
          <button
            type="button"
            onClick={() => void fetchConnections(true)}
            disabled={isRefreshDisabled}
            className="rounded-lg border border-app-border-strong px-3 py-2 text-sm font-medium text-app-text-muted transition hover:border-blue-400 dark:hover:border-blue-400/60 hover:text-blue-700 dark:hover:text-blue-200 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {oauthServices.length === 0 ? (
          <p className="mt-4 text-sm text-app-text-subtle">No OAuth services configured yet.</p>
        ) : visibleOauthServices.length === 0 ? (
          <p className="mt-4 text-sm text-app-text-subtle">All OAuth services are connected.</p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-3">
            {visibleOauthServices.map(({ service: oauthService, name }) => (
              <button
                key={oauthService}
                type="button"
                onClick={() => openOAuth(oauthService)}
                className="rounded-lg border border-app-border-strong px-3 py-2 text-sm font-medium text-app-text-muted transition hover:border-blue-400 dark:hover:border-blue-400/60 hover:text-blue-700 dark:hover:text-blue-200"
              >
                {name} Connect
              </button>
            ))}
          </div>
        )}

        {showOauthHint ? (
          <p className="mt-4 text-sm text-app-text-subtle">
            Complete the authorization in the new tab, then refresh this page.
          </p>
        ) : null}
      </section>
    </section>
  );
}
