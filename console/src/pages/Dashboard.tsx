import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  apiFetch,
  fetchBusinesses,
  fetchBusinessConnectionStatus,
  type ApiError,
  type BusinessConnectionStatus,
  type BusinessRecord,
} from "../api/client";
import DataTable, { type Column } from "../components/DataTable";
import { useAuth } from "../context/AuthContext";
import { useRole } from "../context/RoleContext";
import { relativeTime } from "../utils/time";

type AdapterRecord = {
  platform: string;
  status: "public" | "sandbox" | "rejected" | string;
  owner: boolean;
  ownerId: string;
  source: string;
  meta?: unknown;
};

type KeyTier = "free" | "paid";

type CreateKeyResponse = {
  id: string;
  key: string;
  label: string;
  tier: KeyTier;
  scopes: string[];
  createdAt: string;
  warning: string;
};

type PublicBusinessDirectoryResponse = {
  businesses?: Array<unknown>;
};

type BusinessActivityEntry = {
  id: string;
  timestamp: string;
  action: string;
  service: string;
  metadata: Record<string, unknown> | null;
};

type BusinessActivityResponse = {
  businessId: string;
  entries: BusinessActivityEntry[];
  has_more: boolean;
};

type BusinessActivityState = {
  entries: BusinessActivityEntry[];
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
};

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const BUSINESS_ACTIVITY_PAGE_SIZE = 20;

function providerLabel(provider: string): string {
  if (provider === "google") {
    return "Google";
  }
  if (provider === "github") {
    return "GitHub";
  }
  return provider;
}

function toTitleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (match) => match.toUpperCase());
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

  return toTitleCase(action);
}

function activityActionClassName(action: string): string {
  if (action === "credential_retrieved" || action === "dek_unwrapped") {
    return "text-blue-700 dark:text-blue-200";
  }

  if (action === "credential_stored" || action === "connection_completed") {
    return "text-emerald-700 dark:text-emerald-200";
  }

  if (action === "credential_deleted" || action === "connection_failed") {
    return "text-red-700 dark:text-red-300";
  }

  return "text-app-text-muted";
}

function metadataValueToText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const items = value
      .map((entry) => metadataValueToText(entry))
      .filter((entry): entry is string => Boolean(entry));
    if (items.length > 0) {
      return items.join(", ");
    }
  }

  return null;
}

function formatActivityDetails(metadata: Record<string, unknown> | null): string {
  if (!metadata) {
    return "-";
  }

  const details: string[] = [];
  const typeValue = metadataValueToText(
    metadata["credential_type"] ?? metadata["credentialType"] ?? metadata["auth_type"] ?? metadata["authType"],
  );
  if (typeValue) {
    details.push(`Type: ${toTitleCase(typeValue)}`);
  }

  const serviceValue = metadataValueToText(metadata["connection_service"] ?? metadata["connectionService"]);
  if (serviceValue) {
    details.push(`Service: ${toTitleCase(serviceValue)}`);
  }

  const domainValue = metadataValueToText(metadata["domain"]);
  if (domainValue) {
    details.push(`Domain: ${domainValue}`);
  }

  if (details.length > 0) {
    return details.join(" · ");
  }

  const fallbackEntries = Object.entries(metadata)
    .map(([key, value]) => {
      const normalized = metadataValueToText(value);
      if (!normalized) {
        return null;
      }
      return `${toTitleCase(key)}: ${normalized}`;
    })
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 2);

  return fallbackEntries.length > 0 ? fallbackEntries.join(" · ") : "-";
}

function createDefaultBusinessActivityState(): BusinessActivityState {
  return {
    entries: [],
    hasMore: false,
    loaded: false,
    loading: false,
    loadingMore: false,
    error: null,
  };
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { activeRole } = useRole();

  const isBusinessView = activeRole === "business";
  const isAdminView = activeRole === "admin";
  const isDeveloperView = activeRole === "developer";
  const isConsumerView = activeRole === "consumer";
  const shouldLoadAdapters = isAdminView || isDeveloperView;

  const [adapters, setAdapters] = useState<AdapterRecord[]>([]);
  const [isLoadingAdapters, setIsLoadingAdapters] = useState(true);
  const [adaptersError, setAdaptersError] = useState<string | null>(null);
  const [keyLabel, setKeyLabel] = useState("Console Key");
  const [keyTier, setKeyTier] = useState<KeyTier>("paid");
  const [isCreatingKey, setIsCreatingKey] = useState(false);
  const [createKeyError, setCreateKeyError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<CreateKeyResponse | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const [businesses, setBusinesses] = useState<BusinessRecord[]>([]);
  const [isLoadingBusiness, setIsLoadingBusiness] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState<BusinessConnectionStatus | null>(null);
  const [businessActivity, setBusinessActivity] = useState<BusinessActivityState>(
    createDefaultBusinessActivityState(),
  );

  const [businessCount, setBusinessCount] = useState<number | null>(null);
  const [isLoadingBusinessCount, setIsLoadingBusinessCount] = useState(false);
  const [businessCountError, setBusinessCountError] = useState<string | null>(null);
  const primaryBusiness = businesses[0];

  useEffect(() => {
    if (!shouldLoadAdapters) {
      setIsLoadingAdapters(false);
      setAdaptersError(null);
      return;
    }

    let disposed = false;
    setIsLoadingAdapters(true);

    void (async () => {
      try {
        const rows = await apiFetch<AdapterRecord[]>("/adapters");
        if (disposed) {
          return;
        }
        setAdapters(rows);
        setAdaptersError(null);
      } catch (error) {
        if (disposed) {
          return;
        }
        const apiError = error as Partial<ApiError>;
        setAdaptersError(apiError.message ?? "Failed to load adapters.");
      } finally {
        if (!disposed) {
          setIsLoadingAdapters(false);
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, [shouldLoadAdapters]);

  useEffect(() => {
    if (!isBusinessView) {
      setIsLoadingBusiness(false);
      setBusinesses([]);
      setConnectionStatus(null);
      setBusinessActivity(createDefaultBusinessActivityState());
      return;
    }

    let disposed = false;
    setIsLoadingBusiness(true);

    void (async () => {
      try {
        const rows = await fetchBusinesses();
        if (disposed) {
          return;
        }

        setBusinesses(rows);

        if (rows.length === 0) {
          setConnectionStatus(null);
          return;
        }

        try {
          const first = rows[0];
          if (!first) {
            return;
          }

          const status = await fetchBusinessConnectionStatus(first.id);
          if (!disposed) {
            setConnectionStatus(status);
          }
        } catch {
          if (!disposed) {
            setConnectionStatus(null);
          }
        }
      } catch {
        if (!disposed) {
          setBusinesses([]);
          setConnectionStatus(null);
        }
      } finally {
        if (!disposed) {
          setIsLoadingBusiness(false);
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, [isBusinessView]);

  useEffect(() => {
    if (!isAdminView) {
      setBusinessCount(null);
      setIsLoadingBusinessCount(false);
      setBusinessCountError(null);
      return;
    }

    let disposed = false;
    setIsLoadingBusinessCount(true);

    void (async () => {
      try {
        const response = await apiFetch<PublicBusinessDirectoryResponse>("/agp/businesses");
        if (disposed) {
          return;
        }

        const count = Array.isArray(response.businesses) ? response.businesses.length : 0;
        setBusinessCount(count);
        setBusinessCountError(null);
      } catch (error) {
        if (disposed) {
          return;
        }

        const apiError = error as Partial<ApiError>;
        setBusinessCountError(apiError.message ?? "Failed to load business stats.");
      } finally {
        if (!disposed) {
          setIsLoadingBusinessCount(false);
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, [isAdminView]);

  useEffect(() => {
    if (!isBusinessView || !primaryBusiness) {
      setBusinessActivity(createDefaultBusinessActivityState());
      return;
    }

    let disposed = false;
    setBusinessActivity({
      entries: [],
      hasMore: false,
      loaded: false,
      loading: true,
      loadingMore: false,
      error: null,
    });

    void (async () => {
      try {
        const activity = await apiFetch<BusinessActivityResponse>(
          `/businesses/${encodeURIComponent(primaryBusiness.id)}/activity?limit=${BUSINESS_ACTIVITY_PAGE_SIZE}`,
        );
        if (disposed) {
          return;
        }

        setBusinessActivity({
          entries: activity.entries,
          hasMore: activity.has_more,
          loaded: true,
          loading: false,
          loadingMore: false,
          error: null,
        });
      } catch (error) {
        if (disposed) {
          return;
        }

        const apiError = error as Partial<ApiError>;
        setBusinessActivity({
          entries: [],
          hasMore: false,
          loaded: true,
          loading: false,
          loadingMore: false,
          error: apiError.message ?? "Failed to load activity.",
        });
      }
    })();

    return () => {
      disposed = true;
    };
  }, [isBusinessView, primaryBusiness?.id]);

  const adapterStats = useMemo(() => {
    let publicCount = 0;
    let sandboxCount = 0;

    for (const adapter of adapters) {
      if (adapter.status === "public") {
        publicCount += 1;
      } else if (adapter.status === "sandbox") {
        sandboxCount += 1;
      }
    }

    return {
      total: publicCount + sandboxCount,
      publicCount,
      sandboxCount,
    };
  }, [adapters]);

  const businessActivityColumns = useMemo<Column<BusinessActivityEntry>[]>(
    () => [
      {
        key: "action",
        header: "Action",
        render: (entry) => (
          <span className={`font-medium ${activityActionClassName(entry.action)}`}>
            {toActivityActionLabel(entry.action)}
          </span>
        ),
      },
      {
        key: "service",
        header: "Service",
        render: (entry) => (entry.service.trim() ? toTitleCase(entry.service) : "-"),
        className: "text-app-text",
      },
      {
        key: "time",
        header: "Time",
        render: (entry) => relativeTime(entry.timestamp),
        className: "whitespace-nowrap text-app-text-subtle",
      },
      {
        key: "details",
        header: "Details",
        render: (entry) => formatActivityDetails(entry.metadata),
        className: "text-app-text-subtle",
      },
    ],
    [],
  );

  async function handleCreateKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsCreatingKey(true);
    setCreateKeyError(null);
    setCreatedKey(null);
    setCopyStatus(null);

    try {
      const created = await apiFetch<CreateKeyResponse>("/keys", {
        method: "POST",
        body: JSON.stringify({
          label: keyLabel.trim() || "Console Key",
          tier: keyTier,
        }),
      });
      setCreatedKey(created);
    } catch (error) {
      const apiError = error as Partial<ApiError>;
      setCreateKeyError(apiError.message ?? "Failed to create API key.");
    } finally {
      setIsCreatingKey(false);
    }
  }

  async function handleCopyKey(): Promise<void> {
    if (!createdKey?.key) {
      return;
    }

    try {
      await navigator.clipboard.writeText(createdKey.key);
      setCopyStatus("Copied.");
    } catch {
      setCopyStatus("Copy failed. Copy manually.");
    }
  }

  async function handleLoadMoreBusinessActivity(): Promise<void> {
    if (!primaryBusiness || businessActivity.loading || businessActivity.loadingMore || !businessActivity.hasMore) {
      return;
    }

    const lastEntry = businessActivity.entries[businessActivity.entries.length - 1];
    if (!lastEntry) {
      return;
    }

    setBusinessActivity((previous) => ({
      ...previous,
      loadingMore: true,
      error: null,
    }));

    try {
      const activity = await apiFetch<BusinessActivityResponse>(
        `/businesses/${encodeURIComponent(primaryBusiness.id)}/activity?limit=${BUSINESS_ACTIVITY_PAGE_SIZE}&before=${encodeURIComponent(lastEntry.timestamp)}`,
      );

      setBusinessActivity((previous) => ({
        ...previous,
        entries: [...previous.entries, ...activity.entries],
        hasMore: activity.has_more,
        loaded: true,
        loadingMore: false,
        error: null,
      }));
    } catch (error) {
      const apiError = error as Partial<ApiError>;
      setBusinessActivity((previous) => ({
        ...previous,
        loadingMore: false,
        error: apiError.message ?? "Failed to load more activity.",
      }));
    }
  }

  if (isBusinessView) {
    const isConnected = connectionStatus?.connected === true;
    const categoryLabel = primaryBusiness?.category ? toTitleCase(primaryBusiness.category) : "Uncategorized";
    const locationLabel = primaryBusiness?.location?.trim() || "Not set";

    return (
      <section className="space-y-6">
        <header className="rounded-xl border border-app-border bg-app-surface p-6">
          <h1 className="text-2xl font-semibold text-app-text md:text-3xl">
            Welcome back, {user?.name?.trim() || user?.email || "Developer"}
          </h1>
          <p className="mt-2 text-sm text-app-text-subtle">Agenr Business Dashboard</p>
        </header>

        <div className="grid gap-4 lg:grid-cols-2">
          <article className="rounded-xl border border-app-border bg-app-surface p-6">
            <h2 className="text-lg font-semibold text-app-text">My Business</h2>
            {isLoadingBusiness ? (
              <p className="mt-4 text-sm text-app-text-subtle">Loading...</p>
            ) : !primaryBusiness ? (
              <div className="mt-4 space-y-4">
                <p className="text-sm text-app-text-subtle">No business registered yet.</p>
                <button
                  type="button"
                  onClick={() => navigate("/businesses")}
                  className="rounded-lg border border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/15 px-4 py-2 text-sm font-medium text-blue-700 dark:text-blue-200 transition hover:border-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/25"
                >
                  Register Business
                </button>
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <dl className="space-y-3 text-sm text-app-text-muted">
                  <div>
                    <dt className="text-xs uppercase tracking-wider text-app-text-subtle">Name</dt>
                    <dd className="mt-1 text-app-text">{primaryBusiness.name}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wider text-app-text-subtle">Category</dt>
                    <dd className="mt-1 text-app-text">{categoryLabel}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wider text-app-text-subtle">Location</dt>
                    <dd className="mt-1 text-app-text">{locationLabel}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wider text-app-text-subtle">Platform</dt>
                    <dd className="mt-1 text-app-text">{primaryBusiness.platform}</dd>
                  </div>
                </dl>

                <div className="rounded-lg border border-app-border bg-app-surface-alt p-4">
                  <p className="text-xs uppercase tracking-wider text-app-text-subtle">Connection Status</p>
                  {isConnected ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                      <span className="rounded-full border border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/15 px-2.5 py-1 text-xs font-medium text-green-700 dark:text-green-200">
                        Connected
                      </span>
                      <span className="text-app-text-muted">{connectionStatus?.service}</span>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <span className="rounded-full border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-200">
                        Not Connected
                      </span>
                      <button
                        type="button"
                        onClick={() => navigate("/businesses")}
                        className="rounded-md border border-app-border-strong bg-app-surface-alt px-3 py-1.5 text-xs font-medium text-app-text transition hover:border-app-border-strong hover:bg-app-surface-soft"
                      >
                        Connect
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </article>

          <article className="rounded-xl border border-app-border bg-app-surface p-6">
            <h2 className="text-lg font-semibold text-app-text">Quick Actions</h2>
            <p className="mt-2 text-sm text-app-text-subtle">Manage your business on AGENR.</p>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => navigate("/businesses")}
                className="rounded-lg border border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/15 px-4 py-3 text-sm font-medium text-blue-700 dark:text-blue-200 transition hover:border-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/25"
              >
                Manage Business
              </button>
              <button
                type="button"
                onClick={() => navigate("/connections")}
                className="rounded-lg border border-app-border-strong bg-app-surface-alt px-4 py-3 text-sm font-medium text-app-text transition hover:border-app-border-strong hover:bg-app-surface-soft"
              >
                View Connections
              </button>
            </div>
          </article>
        </div>

        <article className="rounded-xl border border-app-border bg-app-surface p-6">
          <h2 className="text-lg font-semibold text-app-text">Recent Activity</h2>
          <p className="mt-2 text-sm text-app-text-subtle">Recent transactions through your business.</p>
          <div className="mt-4">
            <DataTable
              columns={businessActivityColumns}
              rows={businessActivity.entries}
              rowKey={(entry) => entry.id}
              loading={businessActivity.loading && !businessActivity.loaded}
              loadingMessage="Loading activity..."
              emptyMessage="No recent activity."
              error={businessActivity.error}
              hasMore={businessActivity.hasMore}
              loadingMore={businessActivity.loadingMore}
              onLoadMore={() => void handleLoadMoreBusinessActivity()}
              loadMoreLabel="Load More"
            />
          </div>
        </article>
      </section>
    );
  }

  if (isAdminView) {
    return (
      <section className="space-y-6">
        <header className="rounded-xl border border-app-border bg-app-surface p-6">
          <h1 className="text-2xl font-semibold text-app-text md:text-3xl">
            Welcome back, {user?.name?.trim() || user?.email || "Admin"}
          </h1>
          <p className="mt-2 text-sm text-app-text-subtle">Agenr Admin Console</p>
        </header>

        <div className="grid gap-4 lg:grid-cols-3">
          <article className="rounded-xl border border-app-border bg-app-surface p-6 lg:col-span-2">
            <h2 className="text-lg font-semibold text-app-text">Platform Stats</h2>
            <p className="mt-2 text-sm text-app-text-subtle">Snapshot of current AGENR platform activity.</p>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-app-border bg-app-surface-alt p-4">
                <p className="text-xs uppercase tracking-wider text-app-text-subtle">Users</p>
                <p className="mt-2 text-2xl font-semibold text-app-text">—</p>
              </div>
              <div className="rounded-lg border border-app-border bg-app-surface-alt p-4">
                <p className="text-xs uppercase tracking-wider text-app-text-subtle">Businesses</p>
                <p className="mt-2 text-2xl font-semibold text-app-text">
                  {isLoadingBusinessCount ? "..." : businessCount ?? "—"}
                </p>
              </div>
              <div className="rounded-lg border border-app-border bg-app-surface-alt p-4">
                <p className="text-xs uppercase tracking-wider text-app-text-subtle">Adapters</p>
                <p className="mt-2 text-2xl font-semibold text-app-text">
                  {isLoadingAdapters ? "..." : adapterStats.total}
                </p>
              </div>
            </div>

            {businessCountError ? <p className="mt-4 text-sm text-red-700 dark:text-red-300">{businessCountError}</p> : null}
          </article>

          <article className="rounded-xl border border-app-border bg-app-surface p-6">
            <h2 className="text-lg font-semibold text-app-text">Adapter Stats</h2>
            {isLoadingAdapters ? (
              <p className="mt-4 text-sm text-app-text-subtle">Loading...</p>
            ) : adaptersError ? (
              <p className="mt-4 text-sm text-red-700 dark:text-red-300">{adaptersError}</p>
            ) : (
              <div className="mt-4 space-y-1">
                <p className="text-3xl font-semibold text-app-text">{adapterStats.total}</p>
                <p className="text-sm text-app-text-subtle">
                  {adapterStats.publicCount} public / {adapterStats.sandboxCount} sandbox
                </p>
              </div>
            )}
          </article>
        </div>

        <article className="rounded-xl border border-app-border bg-app-surface p-6">
          <h2 className="text-lg font-semibold text-app-text">Quick Actions</h2>
          <p className="mt-2 text-sm text-app-text-subtle">Manage core platform workflows.</p>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => navigate("/adapters")}
              className="rounded-lg border border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/15 px-4 py-3 text-sm font-medium text-blue-700 dark:text-blue-200 transition hover:border-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/25"
            >
              Review Adapters
            </button>
            <button
              type="button"
              onClick={() => navigate("/businesses")}
              className="rounded-lg border border-app-border-strong bg-app-surface-alt px-4 py-3 text-sm font-medium text-app-text transition hover:border-app-border-strong hover:bg-app-surface-soft"
            >
              View Businesses
            </button>
            <button
              type="button"
              onClick={() => navigate("/playground")}
              className="rounded-lg border border-app-border-strong bg-app-surface-alt px-4 py-3 text-sm font-medium text-app-text transition hover:border-app-border-strong hover:bg-app-surface-soft"
            >
              API Playground
            </button>
          </div>
        </article>

        <article className="rounded-xl border border-app-border bg-app-surface p-6">
          <h2 className="text-lg font-semibold text-app-text">API Keys</h2>
          <p className="mt-2 text-sm text-app-text-subtle">
            Create an API key for AGP requests. The raw key is shown only once.
          </p>
          <form className="mt-4 space-y-3" onSubmit={(event) => void handleCreateKey(event)}>
            <div>
              <label htmlFor="key-label" className="text-xs uppercase tracking-wider text-app-text-subtle">
                Label
              </label>
              <input
                id="key-label"
                value={keyLabel}
                onChange={(event) => setKeyLabel(event.target.value)}
                className="mt-1 w-full rounded-md border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400"
              />
            </div>
            <div>
              <label htmlFor="key-tier" className="text-xs uppercase tracking-wider text-app-text-subtle">
                Tier
              </label>
              <select
                id="key-tier"
                value={keyTier}
                onChange={(event) => setKeyTier(event.target.value as KeyTier)}
                className="mt-1 w-full rounded-md border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400"
              >
                <option value="paid">Paid</option>
                <option value="free">Free</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={isCreatingKey}
              className="rounded-lg border border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/15 px-4 py-2 text-sm font-medium text-blue-700 dark:text-blue-200 transition hover:border-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isCreatingKey ? "Creating..." : "Create API Key"}
            </button>
          </form>

          {createKeyError ? <p className="mt-3 text-sm text-red-700 dark:text-red-300">{createKeyError}</p> : null}

          {createdKey ? (
            <div className="mt-4 rounded-lg border border-amber-300 dark:border-amber-400/40 bg-amber-50 dark:bg-amber-500/10 p-4">
              <p className="text-xs uppercase tracking-wider text-amber-700 dark:text-amber-200">New key</p>
              <p className="mt-2 break-all rounded bg-app-surface-alt p-2 font-mono text-xs text-amber-800 dark:text-amber-100">{createdKey.key}</p>
              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void handleCopyKey()}
                  className="rounded-md border border-app-border-strong bg-app-surface-alt px-3 py-1.5 text-xs font-medium text-app-text transition hover:border-app-border-strong hover:bg-app-surface-soft"
                >
                  Copy key
                </button>
                {copyStatus ? <span className="text-xs text-app-text-muted">{copyStatus}</span> : null}
              </div>
              <p className="mt-3 text-xs text-amber-700 dark:text-amber-200">{createdKey.warning}</p>
            </div>
          ) : null}
        </article>
      </section>
    );
  }

  if (isConsumerView) {
    return (
      <section className="space-y-6">
        <header className="rounded-xl border border-app-border bg-app-surface p-6">
          <h1 className="text-2xl font-semibold text-app-text md:text-3xl">
            Welcome back, {user?.name?.trim() || user?.email || "Consumer"}
          </h1>
          <p className="mt-2 text-sm text-app-text-subtle">Agenr Consumer Console</p>
        </header>

        <article className="rounded-xl border border-app-border bg-app-surface p-6">
          <h2 className="text-lg font-semibold text-app-text">Quick Actions</h2>
          <p className="mt-2 text-sm text-app-text-subtle">Explore integrations and test AGP workflows.</p>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => navigate("/playground")}
              className="rounded-lg border border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/15 px-4 py-3 text-sm font-medium text-blue-700 dark:text-blue-200 transition hover:border-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/25"
            >
              API Playground
            </button>
            <button
              type="button"
              onClick={() => navigate("/adapters")}
              className="rounded-lg border border-app-border-strong bg-app-surface-alt px-4 py-3 text-sm font-medium text-app-text transition hover:border-app-border-strong hover:bg-app-surface-soft"
            >
              Browse Adapters
            </button>
          </div>
        </article>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <header className="rounded-xl border border-app-border bg-app-surface p-6">
        <h1 className="text-2xl font-semibold text-app-text md:text-3xl">
          Welcome back, {user?.name?.trim() || user?.email || "Developer"}
        </h1>
        <p className="mt-2 text-sm text-app-text-subtle">Agenr Developer Console</p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <article className="rounded-xl border border-app-border bg-app-surface p-6">
          <h2 className="text-lg font-semibold text-app-text">Account</h2>
          <dl className="mt-4 space-y-3 text-sm text-app-text-muted">
            <div>
              <dt className="text-xs uppercase tracking-wider text-app-text-subtle">Email</dt>
              <dd className="mt-1 text-app-text">{user?.email ?? "Unknown"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wider text-app-text-subtle">Provider</dt>
              <dd className="mt-1 text-app-text">{providerLabel(user?.provider ?? "unknown")}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wider text-app-text-subtle">User ID</dt>
              <dd className="mt-1 font-mono text-xs text-app-text-muted">{user?.id ?? "Unknown"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wider text-app-text-subtle">Session</dt>
              <dd className="mt-1 text-app-text">Active</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wider text-app-text-subtle">Signed in</dt>
              <dd className="mt-1 text-app-text">{DATE_FORMATTER.format(new Date())}</dd>
            </div>
          </dl>
        </article>

        <article className="rounded-xl border border-app-border bg-app-surface p-6">
          <h2 className="text-lg font-semibold text-app-text">Quick Actions</h2>
          <p className="mt-2 text-sm text-app-text-subtle">Jump to common development workflows.</p>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => navigate("/adapters")}
              className="rounded-lg border border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/15 px-4 py-3 text-sm font-medium text-blue-700 dark:text-blue-200 transition hover:border-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/25"
            >
              Generate Adapter
            </button>
            <button
              type="button"
              onClick={() => navigate("/playground")}
              className="rounded-lg border border-app-border-strong bg-app-surface-alt px-4 py-3 text-sm font-medium text-app-text transition hover:border-app-border-strong hover:bg-app-surface-soft"
            >
              API Playground
            </button>
            <button
              type="button"
              onClick={() => navigate("/adapters")}
              className="rounded-lg border border-app-border-strong bg-app-surface-alt px-4 py-3 text-sm font-medium text-app-text transition hover:border-app-border-strong hover:bg-app-surface-soft"
            >
              View Adapters
            </button>
          </div>
        </article>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <article className="rounded-xl border border-app-border bg-app-surface p-6">
          <h2 className="text-lg font-semibold text-app-text">Adapters</h2>
          {isLoadingAdapters ? (
            <p className="mt-4 text-sm text-app-text-subtle">Loading...</p>
          ) : adaptersError ? (
            <p className="mt-4 text-sm text-red-700 dark:text-red-300">{adaptersError}</p>
          ) : (
            <div className="mt-4 space-y-1">
              <p className="text-3xl font-semibold text-app-text">{adapterStats.total}</p>
              <p className="text-sm text-app-text-subtle">
                {adapterStats.publicCount} public / {adapterStats.sandboxCount} sandbox
              </p>
            </div>
          )}
        </article>

        <article className="rounded-xl border border-app-border bg-app-surface p-6">
          <h2 className="text-lg font-semibold text-app-text">API Keys</h2>
          <p className="mt-2 text-sm text-app-text-subtle">
            Create an API key for AGP requests. The raw key is shown only once.
          </p>
          <form className="mt-4 space-y-3" onSubmit={(event) => void handleCreateKey(event)}>
            <div>
              <label htmlFor="key-label" className="text-xs uppercase tracking-wider text-app-text-subtle">
                Label
              </label>
              <input
                id="key-label"
                value={keyLabel}
                onChange={(event) => setKeyLabel(event.target.value)}
                className="mt-1 w-full rounded-md border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400"
              />
            </div>
            <div>
              <label htmlFor="key-tier" className="text-xs uppercase tracking-wider text-app-text-subtle">
                Tier
              </label>
              <select
                id="key-tier"
                value={keyTier}
                onChange={(event) => setKeyTier(event.target.value as KeyTier)}
                className="mt-1 w-full rounded-md border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400"
              >
                <option value="paid">Paid</option>
                <option value="free">Free</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={isCreatingKey}
              className="rounded-lg border border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/15 px-4 py-2 text-sm font-medium text-blue-700 dark:text-blue-200 transition hover:border-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isCreatingKey ? "Creating..." : "Create API Key"}
            </button>
          </form>

          {createKeyError ? <p className="mt-3 text-sm text-red-700 dark:text-red-300">{createKeyError}</p> : null}

          {createdKey ? (
            <div className="mt-4 rounded-lg border border-amber-300 dark:border-amber-400/40 bg-amber-50 dark:bg-amber-500/10 p-4">
              <p className="text-xs uppercase tracking-wider text-amber-700 dark:text-amber-200">New key</p>
              <p className="mt-2 break-all rounded bg-app-surface-alt p-2 font-mono text-xs text-amber-800 dark:text-amber-100">{createdKey.key}</p>
              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void handleCopyKey()}
                  className="rounded-md border border-app-border-strong bg-app-surface-alt px-3 py-1.5 text-xs font-medium text-app-text transition hover:border-app-border-strong hover:bg-app-surface-soft"
                >
                  Copy key
                </button>
                {copyStatus ? <span className="text-xs text-app-text-muted">{copyStatus}</span> : null}
              </div>
              <p className="mt-3 text-xs text-amber-700 dark:text-amber-200">{createdKey.warning}</p>
            </div>
          ) : null}
        </article>
      </div>
    </section>
  );
}
