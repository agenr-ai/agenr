import { type ChangeEvent, type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  createAppCredential,
  deleteAppCredential,
  listAppCredentials,
  type ApiError,
  type AppCredential,
} from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useRole } from "../context/RoleContext";

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

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
      return detail || "Validation failed. Check service name and credential values.";
    }
    if (error.status === 403) {
      return detail || "Admin scope is required to manage app credentials.";
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

function toServiceLabel(value: string): string {
  return value
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }

  return DATE_TIME_FORMATTER.format(parsed);
}

export default function AppCredentials() {
  const { user } = useAuth();
  const { activeRole } = useRole();

  const [credentials, setCredentials] = useState<AppCredential[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [service, setService] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingService, setDeletingService] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const isAdminUser = user?.isAdmin === true;
  const isAdminView = activeRole === "admin";

  const sortedCredentials = useMemo(
    () => [...credentials].sort((left, right) => left.service.localeCompare(right.service)),
    [credentials],
  );

  const loadCredentials = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);

    try {
      const rows = await listAppCredentials();
      setCredentials(rows);
    } catch (error) {
      setLoadError(toApiErrorMessage(error, "Unable to load app credentials."));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdminUser || !isAdminView) {
      setIsLoading(false);
      setCredentials([]);
      return;
    }

    void loadCredentials();
  }, [isAdminUser, isAdminView, loadCredentials]);

  function handleServiceChange(event: ChangeEvent<HTMLInputElement>): void {
    setService(event.target.value.toLowerCase());
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setActionError(null);
    setActionSuccess(null);

    const normalizedService = service.trim().toLowerCase();
    const trimmedClientId = clientId.trim();
    const trimmedClientSecret = clientSecret.trim();

    if (!normalizedService) {
      setActionError("Service name is required.");
      return;
    }
    if (!trimmedClientId) {
      setActionError("Client ID is required.");
      return;
    }
    if (!trimmedClientSecret) {
      setActionError("Client Secret is required.");
      return;
    }

    setIsSubmitting(true);

    try {
      await createAppCredential(normalizedService, trimmedClientId, trimmedClientSecret);
      setActionSuccess(`Configured ${toServiceLabel(normalizedService)} credentials.`);
      setService("");
      setClientId("");
      setClientSecret("");
      await loadCredentials();
    } catch (error) {
      setActionError(toApiErrorMessage(error, `Unable to configure ${normalizedService}.`));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDelete(credential: AppCredential): Promise<void> {
    const label = toServiceLabel(credential.service);
    if (!confirm(`Delete app credentials for "${label}"?`)) {
      return;
    }

    setDeletingService(credential.service);
    setActionError(null);
    setActionSuccess(null);

    try {
      await deleteAppCredential(credential.service);
      setActionSuccess(`Removed ${label} credentials.`);
      await loadCredentials();
    } catch (error) {
      setActionError(toApiErrorMessage(error, `Unable to delete ${label} credentials.`));
    } finally {
      setDeletingService(null);
    }
  }

  return (
    <section className="space-y-6">
      <header className="rounded-xl border border-app-border bg-app-surface p-6">
        <h1 className="text-2xl font-semibold text-app-text md:text-3xl">App Credentials</h1>
        <p className="mt-2 text-sm text-app-text-subtle">
          Manage OAuth client credentials for third-party services.
        </p>
      </header>

      {!isAdminUser ? (
        <article className="rounded-xl border border-rose-300 dark:border-rose-400/30 bg-rose-50 dark:bg-rose-500/10 p-6">
          <p className="text-sm text-rose-700 dark:text-rose-200">Only admins can access this page.</p>
        </article>
      ) : null}

      {isAdminUser && !isAdminView ? (
        <article className="rounded-xl border border-amber-300 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-500/10 p-6">
          <p className="text-sm text-amber-800 dark:text-amber-100">Switch "View As" to Admin to manage app credentials.</p>
        </article>
      ) : null}

      {isAdminUser && isAdminView ? (
        <>
          {loadError || actionError ? (
            <article className="rounded-xl border border-rose-300 dark:border-rose-400/30 bg-rose-50 dark:bg-rose-500/10 p-4">
              <p className="text-sm text-rose-700 dark:text-rose-200">{actionError ?? loadError}</p>
            </article>
          ) : null}

          {actionSuccess ? (
            <article className="rounded-xl border border-emerald-300 dark:border-emerald-400/30 bg-emerald-50 dark:bg-emerald-500/10 p-4">
              <p className="text-sm text-emerald-700 dark:text-emerald-200">{actionSuccess}</p>
            </article>
          ) : null}

          <article className="rounded-xl border border-app-border bg-app-surface p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-app-text">Configured Credentials</h2>
                <p className="mt-1 text-sm text-app-text-subtle">
                  Client secrets are stored securely and are never returned by this list.
                </p>
              </div>
            </div>

            {isLoading ? (
              <div className="mt-4 inline-flex items-center gap-2 text-sm text-app-text-subtle">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-app-border-strong border-t-blue-500 dark:border-t-blue-300" />
                Loading app credentials...
              </div>
            ) : null}

            {!isLoading && sortedCredentials.length === 0 ? (
              <p className="mt-4 text-sm text-app-text-subtle">No app credentials configured yet.</p>
            ) : null}

            {!isLoading && sortedCredentials.length > 0 ? (
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                {sortedCredentials.map((credential) => {
                  const deleting = deletingService === credential.service;
                  return (
                    <div
                      key={credential.service}
                      className="rounded-lg border border-app-border bg-app-surface-alt p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-base font-semibold text-app-text">
                            {toServiceLabel(credential.service)}
                          </h3>
                          <p className="mt-1 text-xs uppercase tracking-wide text-app-text-subtle">
                            {credential.service}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleDelete(credential)}
                          disabled={deleting}
                          className="rounded-md border border-rose-300 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-500/15 px-3 py-1.5 text-xs font-medium text-rose-700 dark:text-rose-200 transition hover:border-rose-400 hover:bg-rose-100 dark:hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {deleting ? "Deleting..." : "Delete"}
                        </button>
                      </div>
                      <div className="mt-3 space-y-1 text-sm text-app-text-muted">
                        <p>
                          <span className="text-app-text-subtle">Created:</span>{" "}
                          {formatTimestamp(credential.created_at)}
                        </p>
                        <p>
                          <span className="text-app-text-subtle">Updated:</span>{" "}
                          {formatTimestamp(credential.updated_at)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </article>

          <article className="rounded-xl border border-app-border bg-app-surface p-6">
            <h2 className="text-lg font-semibold text-app-text">Add Credential</h2>
            <p className="mt-1 text-sm text-app-text-subtle">
              Configure an OAuth client ID and secret for a service identifier.
            </p>

            <form className="mt-5 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
              <div>
                <label htmlFor="app-credential-service" className="text-xs uppercase tracking-wider text-app-text-subtle">
                  Service Name
                </label>
                <input
                  id="app-credential-service"
                  value={service}
                  onChange={handleServiceChange}
                  onBlur={(event) => setService(event.target.value.trim().toLowerCase())}
                  required
                  autoComplete="off"
                  placeholder="google"
                  className="mt-1 w-full rounded-md border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400"
                />
              </div>

              <div>
                <label htmlFor="app-credential-client-id" className="text-xs uppercase tracking-wider text-app-text-subtle">
                  Client ID
                </label>
                <input
                  id="app-credential-client-id"
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  required
                  autoComplete="off"
                  className="mt-1 w-full rounded-md border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400"
                />
              </div>

              <div>
                <label
                  htmlFor="app-credential-client-secret"
                  className="text-xs uppercase tracking-wider text-app-text-subtle"
                >
                  Client Secret
                </label>
                <input
                  id="app-credential-client-secret"
                  type="password"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                  required
                  autoComplete="new-password"
                  className="mt-1 w-full rounded-md border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400"
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded-lg border border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/15 px-4 py-2 text-sm font-medium text-blue-700 dark:text-blue-200 transition hover:border-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? "Saving..." : "Add Credential"}
              </button>
            </form>
          </article>
        </>
      ) : null}
    </section>
  );
}
