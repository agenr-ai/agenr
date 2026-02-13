import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  buildApiUrl,
  createBusiness,
  deleteBusiness,
  fetchBusinessConnections,
  fetchBusinessConnectionStatus,
  fetchBusinesses,
  fetchOAuthServices,
  getSessionToken,
  type ApiError,
  type BusinessConnectionRecord,
  type BusinessConnectionStatus,
  type BusinessConnectionsResponse,
  type BusinessRecord,
  type OAuthServiceRecord,
} from "../api/client";
import DataTable, { type Column } from "../components/DataTable";
import { useRole } from "../context/RoleContext";
import { relativeTime } from "../utils/time";

type CategoryOption = "restaurant" | "retail" | "saas" | "service" | "other";
type BusinessStatusFilter = "active" | "suspended" | "deleted";

const CATEGORY_OPTIONS: CategoryOption[] = ["restaurant", "retail", "saas", "service", "other"];
const BUSINESS_STATUS_FILTERS: BusinessStatusFilter[] = ["active", "suspended", "deleted"];

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
    if (error.status === 403) {
      return detail || "You do not have access to this business.";
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

function toLabel(value: string): string {
  return value
    .trim()
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function toServiceLabel(service: OAuthServiceRecord): string {
  const trimmedName = service.name.trim();
  if (!trimmedName) {
    return toLabel(service.service);
  }

  if (trimmedName === trimmedName.toLowerCase() || trimmedName === trimmedName.toUpperCase()) {
    return toLabel(trimmedName);
  }

  return trimmedName;
}

function statusBadgeClasses(status: string): string {
  if (status === "suspended") {
    return "border-amber-300 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200";
  }
  if (status === "deleted") {
    return "border-rose-300 dark:border-rose-400/30 bg-rose-50 dark:bg-rose-500/20 text-rose-700 dark:text-rose-200";
  }

  return "border-emerald-300 dark:border-emerald-400/30 bg-emerald-50 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200";
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function truncateText(value: string, maxLength = 18): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}...`;
}

export default function Businesses() {
  const { activeRole } = useRole();
  const isAdminView = activeRole === "admin";
  const [businesses, setBusinesses] = useState<BusinessRecord[]>([]);
  const [isLoadingBusinesses, setIsLoadingBusinesses] = useState(true);
  const [businessesError, setBusinessesError] = useState<string | null>(null);

  const [oauthServices, setOAuthServices] = useState<OAuthServiceRecord[]>([]);
  const [isLoadingOAuthServices, setIsLoadingOAuthServices] = useState(true);
  const [oauthServicesError, setOAuthServicesError] = useState<string | null>(null);

  const [connectionStatuses, setConnectionStatuses] = useState<Record<string, BusinessConnectionStatus>>({});
  const [isLoadingConnectionStatuses, setIsLoadingConnectionStatuses] = useState(false);
  const [businessConnections, setBusinessConnections] = useState<Record<string, BusinessConnectionsResponse>>({});
  const [isLoadingBusinessConnections, setIsLoadingBusinessConnections] = useState(false);

  const [name, setName] = useState("");
  const [platform, setPlatform] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<CategoryOption>("restaurant");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [nameFilter, setNameFilter] = useState("");
  const [statusFilters, setStatusFilters] = useState<Record<BusinessStatusFilter, boolean>>({
    active: true,
    suspended: true,
    deleted: true,
  });

  const oauthServicesByPlatform = useMemo(() => {
    const map = new Map<string, OAuthServiceRecord[]>();

    for (const service of oauthServices) {
      const normalizedService = normalizeName(service.service);
      const platforms = Array.isArray(service.platforms) && service.platforms.length > 0
        ? service.platforms
        : [service.service];

      for (const platformName of platforms) {
        const normalizedPlatform = normalizeName(platformName);
        if (!normalizedPlatform) {
          continue;
        }

        const existing = map.get(normalizedPlatform) ?? [];
        if (!existing.some((entry) => normalizeName(entry.service) === normalizedService)) {
          existing.push(service);
          map.set(normalizedPlatform, existing);
        }
      }
    }

    return map;
  }, [oauthServices]);

  const loadBusinesses = useCallback(async () => {
    setIsLoadingBusinesses(true);
    setBusinessesError(null);

    try {
      const rows = await fetchBusinesses();
      const sorted = [...rows].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      setBusinesses(sorted);
    } catch (error) {
      setBusinessesError(toApiErrorMessage(error, "Unable to load businesses right now."));
    } finally {
      setIsLoadingBusinesses(false);
    }
  }, []);

  const loadOAuthServices = useCallback(async () => {
    setIsLoadingOAuthServices(true);
    setOAuthServicesError(null);

    try {
      const rows = await fetchOAuthServices();
      setOAuthServices(
        [...rows].sort((left, right) => toServiceLabel(left).localeCompare(toServiceLabel(right))),
      );
    } catch (error) {
      setOAuthServicesError(toApiErrorMessage(error, "Unable to load connectable platforms right now."));
    } finally {
      setIsLoadingOAuthServices(false);
    }
  }, []);

  useEffect(() => {
    void loadBusinesses();
    void loadOAuthServices();
  }, [loadBusinesses, loadOAuthServices]);

  useEffect(() => {
    let cancelled = false;

    async function loadConnectionStatuses(): Promise<void> {
      if (businesses.length === 0) {
        setConnectionStatuses({});
        setIsLoadingConnectionStatuses(false);
        return;
      }

      setIsLoadingConnectionStatuses(true);

      const entries = await Promise.all(
        businesses.map(async (business) => {
          try {
            const status = await fetchBusinessConnectionStatus(business.id);
            return [business.id, status] as const;
          } catch {
            return [business.id, { connected: false, service: "" }] as const;
          }
        }),
      );

      if (!cancelled) {
        setConnectionStatuses(Object.fromEntries(entries));
        setIsLoadingConnectionStatuses(false);
      }
    }

    void loadConnectionStatuses();

    return () => {
      cancelled = true;
    };
  }, [businesses]);

  useEffect(() => {
    let cancelled = false;

    async function loadBusinessConnections(): Promise<void> {
      if (businesses.length === 0) {
        setBusinessConnections({});
        setIsLoadingBusinessConnections(false);
        return;
      }

      setIsLoadingBusinessConnections(true);

      const entries = await Promise.all(
        businesses.map(async (business) => {
          try {
            const response = await fetchBusinessConnections(business.id);
            return [business.id, response] as const;
          } catch {
            return null;
          }
        }),
      );

      if (!cancelled) {
        setBusinessConnections(
          Object.fromEntries(
            entries.filter((entry): entry is readonly [string, BusinessConnectionsResponse] => entry !== null),
          ),
        );
        setIsLoadingBusinessConnections(false);
      }
    }

    void loadBusinessConnections();

    return () => {
      cancelled = true;
    };
  }, [businesses]);

  useEffect(() => {
    if (!platform && oauthServices.length > 0) {
      setPlatform(oauthServices[0]!.service);
    }
  }, [platform, oauthServices]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitError(null);
    setSubmitSuccess(null);

    const trimmedName = name.trim();
    const trimmedPlatform = platform.trim().toLowerCase();

    if (!trimmedName) {
      setSubmitError("Business name is required.");
      return;
    }

    if (!trimmedPlatform) {
      setSubmitError("Platform is required.");
      return;
    }

    setIsSubmitting(true);

    try {
      const created = await createBusiness({
        name: trimmedName,
        platform: trimmedPlatform,
        location: location.trim() || undefined,
        description: description.trim() || undefined,
        category: category || undefined,
      });

      setSubmitSuccess(`Registered ${created.name}.`);
      setName("");
      setLocation("");
      setDescription("");
      setCategory("restaurant");
      await loadBusinesses();
    } catch (error) {
      setSubmitError(toApiErrorMessage(error, "Unable to register business."));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDelete(entry: BusinessRecord): Promise<void> {
    if (!confirm(`Delete "${entry.name}"? This only removes it from onboarding and can be restored later by support.`)) {
      return;
    }

    setDeletingId(entry.id);
    setBusinessesError(null);

    try {
      await deleteBusiness(entry.id);
      setBusinesses((previous) => previous.filter((business) => business.id !== entry.id));
    } catch (error) {
      setBusinessesError(toApiErrorMessage(error, `Unable to delete ${entry.name}.`));
    } finally {
      setDeletingId(null);
    }
  }

  function openBusinessConnect(businessId: string, service: string): void {
    const connectPath = `/businesses/${encodeURIComponent(businessId)}/connect/${encodeURIComponent(service)}`;
    const token = getSessionToken();
    const separator = "?";
    const url = token
      ? buildApiUrl(connectPath) + separator + "session_token=" + encodeURIComponent(token)
      : buildApiUrl(connectPath);
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function getBusinessConnectionContext(business: BusinessRecord): {
    connected: boolean;
    oauthEnabled: boolean;
    oauthService: string;
    availableServices: string[];
    filteredConnections: BusinessConnectionRecord[];
    formatServiceName: (serviceName: string) => string;
  } {
    const normalizedPlatform = normalizeName(business.platform);
    const connectionStatus = connectionStatuses[business.id];
    const connectionDetails = businessConnections[business.id];
    const platformServices = oauthServicesByPlatform.get(normalizedPlatform) ?? [];
    const serviceLabelById = new Map(
      platformServices.map((service) => [normalizeName(service.service), toServiceLabel(service)] as const),
    );
    const availableServices = Array.from(
      new Set(
        connectionDetails?.availableServices?.map(normalizeName).filter(Boolean) ??
          connectionStatus?.availableServices?.map(normalizeName).filter(Boolean) ??
          platformServices.map((service) => normalizeName(service.service)).filter(Boolean),
      ),
    );
    const availableServiceSet = new Set(availableServices);
    const oauthService = normalizeName(connectionStatus?.service ?? "") || availableServices[0] || "";
    const oauthEnabled = availableServices.length > 0;
    const connected =
      connectionDetails?.connections.some((connection) =>
        availableServiceSet.has(normalizeName(connection.service)),
      ) ?? (connectionStatus?.connected === true);
    const filteredConnections: BusinessConnectionRecord[] =
      connectionDetails?.connections.filter((connection) =>
        availableServiceSet.has(normalizeName(connection.service)),
      ) ?? [];
    const formatServiceName = (serviceName: string): string =>
      serviceLabelById.get(normalizeName(serviceName)) ?? toLabel(serviceName);

    return {
      connected,
      oauthEnabled,
      oauthService,
      availableServices,
      filteredConnections,
      formatServiceName,
    };
  }

  function toggleStatusFilter(status: BusinessStatusFilter): void {
    setStatusFilters((previous) => ({
      ...previous,
      [status]: !previous[status],
    }));
  }

  const filteredAdminBusinesses = useMemo(() => {
    const normalizedFilter = nameFilter.trim().toLowerCase();

    return businesses.filter((business) => {
      const normalizedStatus = normalizeName(business.status) as BusinessStatusFilter;
      const statusAllowed = statusFilters[normalizedStatus] ?? false;
      const matchesName = normalizedFilter.length === 0 || business.name.toLowerCase().includes(normalizedFilter);
      return statusAllowed && matchesName;
    });
  }, [businesses, nameFilter, statusFilters]);

  const supportsSuspendActions = false;

  const adminColumns: Column<BusinessRecord>[] = useMemo(
    () => [
      {
        key: "name",
        header: "Business",
        className: "font-medium text-app-text",
        render: (business) => business.name,
      },
      {
        key: "owner",
        header: "Owner",
        render: (business) => <span title={business.ownerId}>{truncateText(business.ownerId, 22)}</span>,
      },
      {
        key: "platform",
        header: "Platform",
        render: (business) => toLabel(business.platform),
      },
      {
        key: "status",
        header: "Status",
        render: (business) => (
          <span
            className={[
              "rounded-md border px-2 py-1 text-xs font-medium uppercase tracking-wide",
              statusBadgeClasses(business.status),
            ].join(" ")}
          >
            {business.status}
          </span>
        ),
      },
      {
        key: "connection",
        header: "Connection",
        className: "text-app-text-muted",
        render: (business) => {
          const context = getBusinessConnectionContext(business);
          if (isLoadingConnectionStatuses) {
            return "Checking...";
          }

          if (!context.oauthEnabled) {
            return "No OAuth service";
          }

          return context.connected ? "Connected" : "Needs connection";
        },
      },
      {
        key: "updated",
        header: "Updated",
        className: "text-app-text-muted",
        render: (business) => relativeTime(business.updatedAt),
      },
      {
        key: "actions",
        header: "Actions",
        className: "w-[260px]",
        render: (business) => {
          const deleting = deletingId === business.id;
          const context = getBusinessConnectionContext(business);

          return (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {!isLoadingConnectionStatuses && context.oauthEnabled && context.connected ? (
                <span className="rounded-md border border-emerald-300 dark:border-emerald-400/30 bg-emerald-50 dark:bg-emerald-500/20 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-200">
                  Connected
                </span>
              ) : null}
              {!isLoadingConnectionStatuses && context.oauthEnabled && !context.connected ? (
                <button
                  type="button"
                  onClick={() => openBusinessConnect(business.id, context.oauthService)}
                  className="rounded-md border border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/15 px-2.5 py-1 text-xs font-medium text-blue-700 dark:text-blue-200 transition hover:border-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/25"
                >
                  Connect {context.formatServiceName(context.oauthService)}
                </button>
              ) : null}
              <button
                type="button"
                disabled={deleting}
                onClick={() => void handleDelete(business)}
                className="rounded-md border border-rose-300 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-500/15 px-2.5 py-1 text-xs font-medium text-rose-700 dark:text-rose-200 transition hover:border-rose-400 hover:bg-rose-100 dark:hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
              {supportsSuspendActions ? (
                <button
                  type="button"
                  disabled
                  className="rounded-md border border-app-border-strong px-2.5 py-1 text-xs font-medium text-app-text-muted opacity-60"
                >
                  {business.status === "suspended" ? "Unsuspend" : "Suspend"}
                </button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [businessConnections, connectionStatuses, deletingId, isLoadingConnectionStatuses, oauthServicesByPlatform],
  );

  if (isAdminView) {
    return (
      <section className="space-y-6">
        <header className="rounded-xl border border-app-border bg-app-surface p-6">
          <h1 className="text-2xl font-semibold text-app-text md:text-3xl">All Businesses</h1>
          <p className="mt-2 text-sm text-app-text-subtle">Platform business oversight and management.</p>
        </header>

        <article className="rounded-xl border border-app-border bg-app-surface p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-app-text">Business Registry</h2>
              <p className="mt-1 text-sm text-app-text-subtle">Review owners, status, and platform connection coverage.</p>
            </div>
          </div>

          <div className="mt-4 space-y-3 rounded-xl border border-app-border bg-app-surface-soft p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-app-text-subtle">Status Filters</p>
            <div className="flex flex-wrap gap-2">
              {BUSINESS_STATUS_FILTERS.map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => toggleStatusFilter(status)}
                  className={[
                    "rounded-md border px-2.5 py-1.5 text-xs font-medium transition",
                    statusFilters[status]
                      ? "border-blue-300 dark:border-blue-400/40 bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200"
                      : "border-app-border-strong bg-app-surface-soft text-app-text-muted hover:border-app-border-strong",
                  ].join(" ")}
                >
                  {status}
                </button>
              ))}
            </div>

            <div className="max-w-md">
              <label htmlFor="business-name-filter" className="text-xs font-medium uppercase tracking-wide text-app-text-subtle">
                Search by Business Name
              </label>
              <input
                id="business-name-filter"
                value={nameFilter}
                onChange={(event) => setNameFilter(event.target.value)}
                placeholder="Start typing a business name..."
                className="mt-1 w-full rounded-md border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400"
              />
            </div>

            {!supportsSuspendActions ? (
              <p className="text-xs text-app-text-subtle">Suspend and unsuspend actions are unavailable until a business status update endpoint is exposed.</p>
            ) : null}
          </div>

          {businessesError ? <p className="mt-4 text-sm text-red-700 dark:text-red-300">{businessesError}</p> : null}

          <div className="mt-4">
            <DataTable
              columns={adminColumns}
              rows={filteredAdminBusinesses}
              rowKey={(business) => business.id}
              loading={isLoadingBusinesses}
              loadingMessage="Loading businesses..."
              emptyMessage="No businesses match the current filters."
            />
          </div>
        </article>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <header className="rounded-xl border border-app-border bg-app-surface p-6">
        <h1 className="text-2xl font-semibold text-app-text md:text-3xl">My Businesses</h1>
        <p className="mt-2 text-sm text-app-text-subtle">Register businesses and connect their service accounts.</p>
      </header>

      <article className="rounded-xl border border-app-border bg-app-surface p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-app-text">Registered Businesses</h2>
            <p className="mt-1 text-sm text-app-text-subtle">Each business is linked to one adapter platform.</p>
          </div>
        </div>

        {isLoadingBusinesses ? <p className="mt-4 text-sm text-app-text-subtle">Loading businesses...</p> : null}
        {!isLoadingBusinesses && businessesError ? <p className="mt-4 text-sm text-red-700 dark:text-red-300">{businessesError}</p> : null}

        {!isLoadingBusinesses && !businessesError && businesses.length === 0 ? (
          <p className="mt-4 text-sm text-app-text-subtle">No businesses yet. Register your first business below.</p>
        ) : null}

        {!isLoadingBusinesses && !businessesError && businesses.length > 0 ? (
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {businesses.map((business) => {
              const deleting = deletingId === business.id;
              const normalizedPlatform = normalizeName(business.platform);
              const connectionStatus = connectionStatuses[business.id];
              const connectionDetails = businessConnections[business.id];
              const platformServices = oauthServicesByPlatform.get(normalizedPlatform) ?? [];
              const serviceLabelById = new Map(
                platformServices.map((service) => [normalizeName(service.service), toServiceLabel(service)] as const),
              );
              const availableServices = Array.from(
                new Set(
                  connectionDetails?.availableServices?.map(normalizeName).filter(Boolean) ??
                    connectionStatus?.availableServices?.map(normalizeName).filter(Boolean) ??
                    platformServices.map((service) => normalizeName(service.service)).filter(Boolean),
                ),
              );
              const availableServiceSet = new Set(availableServices);
              const oauthService = normalizeName(connectionStatus?.service ?? "") || availableServices[0] || "";
              const oauthEnabled = availableServices.length > 0;
              const connected =
                connectionDetails?.connections.some((connection) =>
                  availableServiceSet.has(normalizeName(connection.service)),
                ) ?? (connectionStatus?.connected === true);
              const filteredConnections: BusinessConnectionRecord[] =
                connectionDetails?.connections.filter((connection) =>
                  availableServiceSet.has(normalizeName(connection.service)),
                ) ?? [];
              const formatServiceName = (serviceName: string): string =>
                serviceLabelById.get(normalizeName(serviceName)) ?? toLabel(serviceName);

              return (
                <div key={business.id} className="rounded-lg border border-app-border bg-app-surface-alt p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-base font-semibold text-app-text">{business.name}</h3>
                    <span
                      className={[
                        "rounded-md border px-2 py-1 text-xs font-medium uppercase tracking-wide",
                        statusBadgeClasses(business.status),
                      ].join(" ")}
                    >
                      {business.status}
                    </span>
                  </div>

                  <div className="mt-3 space-y-1 text-sm text-app-text-muted">
                    <p>
                      <span className="text-app-text-subtle">Platform:</span> {toLabel(business.platform)}
                    </p>
                    <p>
                      <span className="text-app-text-subtle">Category:</span> {business.category ? toLabel(business.category) : "Not set"}
                    </p>
                    <p>
                      <span className="text-app-text-subtle">Location:</span> {business.location || "Not set"}
                    </p>
                    <p>
                      <span className="text-app-text-subtle">Created:</span> {relativeTime(business.createdAt)}
                    </p>
                    <p>
                      <span className="text-app-text-subtle">Available services:</span>{" "}
                      {availableServices.length > 0
                        ? availableServices.map((serviceName) => formatServiceName(serviceName)).join(", ")
                        : "None"}
                    </p>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {isLoadingConnectionStatuses ? (
                      <span className="rounded-md border border-app-border-strong bg-app-surface px-3 py-1.5 text-xs font-medium text-app-text-muted">
                        Checking connection...
                      </span>
                    ) : null}
                    {!isLoadingConnectionStatuses && oauthEnabled && connected ? (
                      <span className="rounded-md border border-emerald-300 dark:border-emerald-400/30 bg-emerald-50 dark:bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-200">
                        Connected
                      </span>
                    ) : null}
                    {!isLoadingConnectionStatuses && oauthEnabled && !connected ? (
                      <button
                        type="button"
                        onClick={() => openBusinessConnect(business.id, oauthService)}
                        className="rounded-md border border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/15 px-3 py-1.5 text-xs font-medium text-blue-700 dark:text-blue-200 transition hover:border-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/25"
                      >
                        Connect {formatServiceName(oauthService)}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={deleting}
                      onClick={() => void handleDelete(business)}
                      className="rounded-md border border-rose-300 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-500/15 px-3 py-1.5 text-xs font-medium text-rose-700 dark:text-rose-200 transition hover:border-rose-400 hover:bg-rose-100 dark:hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {deleting ? "Deleting..." : "Delete"}
                    </button>
                  </div>

                  {isLoadingBusinessConnections && !connectionDetails ? (
                    <p className="mt-3 text-xs text-app-text-subtle">Loading platform connections...</p>
                  ) : null}
                  {!isLoadingBusinessConnections && connectionDetails ? (
                    <div className="mt-3 rounded-md border border-app-border bg-app-surface-soft p-3">
                      <p className="text-xs uppercase tracking-wide text-app-text-subtle">Platform Connections</p>
                      {filteredConnections.length === 0 ? (
                        <p className="mt-2 text-xs text-app-text-subtle">No connections for this platform yet.</p>
                      ) : (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {filteredConnections.map((connection) => (
                            <span
                              key={`${business.id}:${connection.service}:${connection.createdAt}`}
                              className="inline-flex items-center gap-1 rounded-md border border-emerald-300 dark:border-emerald-400/30 bg-emerald-50 dark:bg-emerald-500/10 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-200"
                            >
                              {formatServiceName(connection.service)}
                              <span className="text-emerald-700/80 dark:text-emerald-300/80">({toLabel(connection.authType)})</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </article>

      <article className="rounded-xl border border-app-border bg-app-surface p-6">
        <h2 className="text-lg font-semibold text-app-text">Register Business</h2>
        <p className="mt-1 text-sm text-app-text-subtle">Add a business and choose the adapter platform it uses.</p>

        <form className="mt-5 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="business-name" className="text-xs uppercase tracking-wider text-app-text-subtle">
                Business Name
              </label>
              <input
                id="business-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                className="mt-1 w-full rounded-md border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400"
                placeholder="Joe's Pizza"
              />
            </div>

            <div>
              <label htmlFor="business-platform" className="text-xs uppercase tracking-wider text-app-text-subtle">
                Platform
              </label>
              <select
                id="business-platform"
                value={platform}
                onChange={(event) => setPlatform(event.target.value)}
                required
                disabled={isLoadingOAuthServices || oauthServices.length === 0}
                className="mt-1 w-full rounded-md border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {oauthServices.length === 0 ? <option value="">No connectable platforms available</option> : null}
                {oauthServices.map((service) => (
                  <option key={service.service} value={service.service}>
                    {toServiceLabel(service)}
                  </option>
                ))}
              </select>
              {oauthServicesError ? <p className="mt-1 text-xs text-red-700 dark:text-red-300">{oauthServicesError}</p> : null}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="business-location" className="text-xs uppercase tracking-wider text-app-text-subtle">
                Location
              </label>
              <input
                id="business-location"
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                className="mt-1 w-full rounded-md border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400"
                placeholder="San Francisco, CA"
              />
            </div>

            <div>
              <label htmlFor="business-category" className="text-xs uppercase tracking-wider text-app-text-subtle">
                Category
              </label>
              <select
                id="business-category"
                value={category}
                onChange={(event) => setCategory(event.target.value as CategoryOption)}
                className="mt-1 w-full rounded-md border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400"
              >
                {CATEGORY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {toLabel(option)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="business-description" className="text-xs uppercase tracking-wider text-app-text-subtle">
              Description
            </label>
            <textarea
              id="business-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400"
              placeholder="Fast-casual pizza and salads with online ordering."
            />
          </div>

          {submitError ? <p className="text-sm text-red-700 dark:text-red-300">{submitError}</p> : null}
          {submitSuccess ? <p className="text-sm text-emerald-600 dark:text-emerald-300">{submitSuccess}</p> : null}

          <button
            type="submit"
            disabled={isSubmitting || isLoadingOAuthServices || oauthServices.length === 0}
            className="rounded-lg border border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/15 px-4 py-2 text-sm font-medium text-blue-700 dark:text-blue-200 transition hover:border-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? "Registering..." : "Register Business"}
          </button>
        </form>
      </article>
    </section>
  );
}
