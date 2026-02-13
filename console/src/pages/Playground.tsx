import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { apiFetch, apiRawFetch } from "../api/client";
import { JsonHighlighter } from "../components/JsonHighlighter";

type Operation = "discover" | "query" | "execute";

type AdapterSummary = {
  platform: string;
  status: string;
};

type ResponseHistoryEntry = {
  id: number;
  operation: Operation;
  endpoint: string;
  requestBody: string;
  status: number;
  durationMs: number;
  requestId: string | null;
  data: unknown;
};

type PendingConfirmation = {
  token: string;
  requestBody: string;
  businessId: string;
  prepareData: unknown;
  prepareHistoryId: number;
};

type PendingAdapterToken = {
  token: string;
  requestBody: string;
  businessId: string;
  confirmHistoryId: number;
};

type DiscoverService = {
  id?: string;
  name?: string;
  description?: string;
  requiresConfirmation?: boolean;
};

type DiscoverHints = {
  typicalFlow?: string;
  queryParams?: Record<string, unknown>;
  executeParams?: Record<string, unknown>;
  confirmationFlow?: string;
  simulationModes?: Record<string, unknown>;
};

type DiscoverData = {
  services?: DiscoverService[];
  hints?: DiscoverHints;
};

type DiscoverCacheEntry = { data: DiscoverData } | { error: string };

const OPERATIONS: Operation[] = ["discover", "query", "execute"];

function buildRequestTemplate(operation: Operation, platform: string): string {
  if (operation === "discover") {
    return JSON.stringify(
      {
        businessId: platform,
      },
      null,
      2,
    );
  }

  if (operation === "query") {
    return JSON.stringify(
      {
        businessId: platform,
        request: {
          serviceId: "catalog",
        },
      },
      null,
      2,
    );
  }

  return JSON.stringify(
    {
      businessId: platform,
      request: {
        serviceId: "order",
        items: [{ productId: "echo-widget-1", quantity: 1 }],
      },
    },
    null,
    2,
  );
}

function getJsonError(value: string): string | null {
  try {
    JSON.parse(value);
    return null;
  } catch {
    return "Invalid JSON";
  }
}

function getStatusPillClass(status: number): string {
  if (status >= 500) {
    return "bg-red-50 dark:bg-red-500/20 text-red-700 dark:text-red-200 ring-red-300 dark:ring-red-400/30";
  }
  if (status >= 400) {
    return "bg-amber-50 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200 ring-amber-300 dark:ring-amber-400/30";
  }
  return "bg-emerald-50 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200 ring-emerald-300 dark:ring-emerald-400/30";
}

function getAdapterStatusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "public") {
    return "bg-emerald-50 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200 ring-emerald-300 dark:ring-emerald-400/30";
  }
  if (normalized === "sandbox") {
    return "bg-amber-50 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200 ring-amber-300 dark:ring-amber-400/30";
  }
  if (normalized === "rejected") {
    return "bg-red-50 dark:bg-red-500/20 text-red-700 dark:text-red-200 ring-red-300 dark:ring-red-400/30";
  }
  return "bg-app-muted-fill text-app-text-muted ring-app-border";
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return fallback;
}

function getRecordValue(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function getEntries(value: unknown): Array<[string, unknown]> {
  const record = getRecordValue(value);
  if (!record) {
    return [];
  }

  return Object.entries(record);
}

function formatHintNote(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    const formatted = JSON.stringify(value);
    return formatted ?? "n/a";
  } catch {
    return "n/a";
  }
}

function formatResponseBody(data: unknown): string {
  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return data;
    }
  }

  const formatted = JSON.stringify(data, null, 2);
  return formatted ?? "null";
}

function getConfirmationToken(data: unknown): string | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }

  const record = data as Record<string, unknown>;

  // Check top-level first (direct adapter response)
  if (typeof record.confirmationToken === "string" && record.confirmationToken.trim().length > 0) {
    return record.confirmationToken;
  }

  // Check nested data (API wraps adapter response in { transactionId, status, data })
  if (typeof record.data === "object" && record.data !== null) {
    const nested = record.data as Record<string, unknown>;
    if (typeof nested.confirmationToken === "string" && nested.confirmationToken.trim().length > 0) {
      return nested.confirmationToken;
    }
  }

  return null;
}

function getBusinessId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("businessId" in payload)) {
    return null;
  }

  const businessId = (payload as { businessId?: unknown }).businessId;
  return typeof businessId === "string" && businessId.trim().length > 0 ? businessId : null;
}

export default function Playground() {
  const [adapters, setAdapters] = useState<AdapterSummary[]>([]);
  const [selectedAdapter, setSelectedAdapter] = useState("");
  const [operation, setOperation] = useState<Operation>("discover");
  const [requestBody, setRequestBody] = useState(buildRequestTemplate("discover", ""));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [adapterError, setAdapterError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [isLoadingAdapters, setIsLoadingAdapters] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [history, setHistory] = useState<ResponseHistoryEntry[]>([]);
  const [activeHistoryId, setActiveHistoryId] = useState<number | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [pendingAdapterToken, setPendingAdapterToken] = useState<PendingAdapterToken | null>(null);
  const [isSendingToken, setIsSendingToken] = useState(false);
  const [discoverCache, setDiscoverCache] = useState<Record<string, DiscoverCacheEntry>>({});
  const [discoverLoading, setDiscoverLoading] = useState<string | null>(null);
  const [isHintsCollapsed, setIsHintsCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const historyIdRef = useRef(1);
  const copyResetTimeoutRef = useRef<number | null>(null);
  const discoverInFlightRef = useRef<Set<string>>(new Set());

  const selectedAdapterInfo = useMemo(
    () => adapters.find((adapter) => adapter.platform === selectedAdapter) ?? null,
    [adapters, selectedAdapter],
  );

  const activeResponse = useMemo(() => {
    if (!history.length) {
      return null;
    }
    if (activeHistoryId === null) {
      return history[0] ?? null;
    }
    return history.find((item) => item.id === activeHistoryId) ?? history[0] ?? null;
  }, [activeHistoryId, history]);

  const pendingPrepareResponse = useMemo(() => {
    if (!pendingConfirmation) {
      return null;
    }
    return history.find((entry) => entry.id === pendingConfirmation.prepareHistoryId) ?? null;
  }, [history, pendingConfirmation]);

  const displayedResponse = pendingPrepareResponse ?? activeResponse;
  const displayedResponseBody = useMemo(
    () => (displayedResponse ? formatResponseBody(displayedResponse.data) : ""),
    [displayedResponse],
  );
  const selectedDiscoverEntry = selectedAdapter ? discoverCache[selectedAdapter] : undefined;
  const selectedDiscoverData =
    selectedDiscoverEntry && "data" in selectedDiscoverEntry ? selectedDiscoverEntry.data : null;
  const selectedDiscoverError =
    selectedDiscoverEntry && "error" in selectedDiscoverEntry ? selectedDiscoverEntry.error : null;
  const discoverHints = selectedDiscoverData?.hints;
  const discoverServices = useMemo(
    () => (Array.isArray(selectedDiscoverData?.services) ? selectedDiscoverData.services : []),
    [selectedDiscoverData],
  );
  const queryHintExamples = useMemo(() => getEntries(discoverHints?.queryParams), [discoverHints]);
  const executeHintExamples = useMemo(() => getEntries(discoverHints?.executeParams), [discoverHints]);
  const simulationModeEntries = useMemo(() => getEntries(discoverHints?.simulationModes), [discoverHints]);

  useEffect(() => {
    let isDisposed = false;

    async function loadAdapters() {
      setIsLoadingAdapters(true);
      setAdapterError(null);

      try {
        const nextAdapters = await apiFetch<AdapterSummary[]>("/adapters", { method: "GET" });
        if (isDisposed) {
          return;
        }

        setAdapters(nextAdapters);
        setSelectedAdapter((current) => {
          if (current && nextAdapters.some((adapter) => adapter.platform === current)) {
            return current;
          }
          return nextAdapters[0]?.platform ?? "";
        });
      } catch (error) {
        if (isDisposed) {
          return;
        }

        setAdapters([]);
        setSelectedAdapter("");
        setAdapterError(getErrorMessage(error, "Unable to load adapters."));
      } finally {
        if (!isDisposed) {
          setIsLoadingAdapters(false);
        }
      }
    }

    void loadAdapters();

    return () => {
      isDisposed = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setCopied(false);
    if (copyResetTimeoutRef.current !== null) {
      window.clearTimeout(copyResetTimeoutRef.current);
      copyResetTimeoutRef.current = null;
    }
  }, [displayedResponse?.id]);

  useEffect(() => {
    const nextTemplate = buildRequestTemplate(operation, selectedAdapter);
    setRequestBody(nextTemplate);
    setJsonError(null);
    setPendingConfirmation(null);
    setPendingAdapterToken(null);
  }, [operation, selectedAdapter]);

  useEffect(() => {
    if (!selectedAdapter) {
      return;
    }
    if (discoverCache[selectedAdapter]) {
      return;
    }
    if (discoverInFlightRef.current.has(selectedAdapter)) {
      return;
    }

    const adapter = selectedAdapter;
    discoverInFlightRef.current.add(adapter);
    setDiscoverLoading(adapter);

    async function loadDiscoverHints() {
      try {
        const response = await apiRawFetch<unknown>("/agp/discover", {
          method: "POST",
          body: JSON.stringify({ businessId: adapter }),
        });

        if (!response.ok) {
          throw {
            message: getErrorMessage(
              typeof response.data === "object" && response.data !== null ? response.data : null,
              "Unable to load request hints",
            ),
          };
        }

        const apiResult = getRecordValue(response.data);
        const adapterData = apiResult?.data;
        const parsedAdapterData = getRecordValue(adapterData);

        if (!parsedAdapterData) {
          throw {
            message: "Unable to load request hints",
          };
        }

        setDiscoverCache((current) => ({
          ...current,
          [adapter]: { data: parsedAdapterData as DiscoverData },
        }));
      } catch (error) {
        setDiscoverCache((current) => ({
          ...current,
          [adapter]: { error: getErrorMessage(error, "Unable to load request hints") },
        }));
      } finally {
        discoverInFlightRef.current.delete(adapter);
        setDiscoverLoading((current) => (current === adapter ? null : current));
      }
    }

    void loadDiscoverHints();
  }, [discoverCache, selectedAdapter]);

  function applyHintExample(nextOperation: Extract<Operation, "query" | "execute">, example: unknown) {
    if (!selectedAdapter) {
      return;
    }

    setOperation(nextOperation);
    setRequestBody(
      JSON.stringify(
        {
          businessId: selectedAdapter,
          request: example,
        },
        null,
        2,
      ),
    );
    setJsonError(null);
    setPendingConfirmation(null);
    setPendingAdapterToken(null);
  }

  function handleRequestChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value;
    setRequestBody(value);
    setJsonError(getJsonError(value));
  }

  function handleRequestKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Tab") {
      return;
    }

    event.preventDefault();

    const textarea = event.currentTarget;
    const { selectionStart, selectionEnd, value } = textarea;
    const nextValue = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;

    setRequestBody(nextValue);
    setJsonError(getJsonError(nextValue));

    requestAnimationFrame(() => {
      textarea.selectionStart = selectionStart + 2;
      textarea.selectionEnd = selectionStart + 2;
    });
  }

  async function handleSendRequest() {
    if (isSending || isConfirming) {
      return;
    }

    const syntaxError = getJsonError(requestBody);
    if (syntaxError) {
      setJsonError(syntaxError);
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(requestBody);
    } catch {
      setJsonError("Invalid JSON");
      return;
    }

    const endpoint = `/agp/${operation}`;
    const businessId = getBusinessId(payload) ?? selectedAdapter;
    setIsSending(true);
    setRequestError(null);
    setPendingConfirmation(null);

    const startedAt = performance.now();

    try {
      const response = await apiRawFetch<unknown>(endpoint, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
      const requestId = response.headers.get("X-Request-Id") ?? response.headers.get("x-request-id");
      const nextEntry: ResponseHistoryEntry = {
        id: historyIdRef.current++,
        operation,
        endpoint,
        requestBody,
        status: response.status,
        durationMs,
        requestId,
        data: response.data,
      };

      setHistory((current) => [nextEntry, ...current].slice(0, 5));
      setActiveHistoryId(nextEntry.id);

      // Check if the adapter returned pending_confirmation with a token
      if (operation === "execute" && response.ok) {
        const adapterToken = getConfirmationToken(response.data);
        if (adapterToken) {
          setPendingAdapterToken({
            token: adapterToken,
            requestBody,
            businessId,
            confirmHistoryId: nextEntry.id,
          });
        }
      }
    } catch (error) {
      setActiveHistoryId(null);
      setRequestError(getErrorMessage(error, "Network request failed."));
    } finally {
      setIsSending(false);
    }
  }

  async function handleConfirmExecute() {
    if (!pendingConfirmation || isConfirming) {
      return;
    }

    setIsConfirming(true);
    setRequestError(null);

    const startedAt = performance.now();

    try {
      // Inject confirmationToken into the request body for adapter-level confirmation
      // and pass it as a header for API-level policy confirmation
      let confirmBody: string;
      try {
        const parsed = JSON.parse(pendingConfirmation.requestBody) as Record<string, unknown>;
        const request = (parsed.request ?? {}) as Record<string, unknown>;
        parsed.request = { ...request, confirmationToken: pendingConfirmation.token };
        confirmBody = JSON.stringify(parsed);
      } catch {
        confirmBody = pendingConfirmation.requestBody;
      }

      const response = await apiRawFetch<unknown>("/agp/execute", {
        method: "POST",
        body: confirmBody,
        headers: {
          "x-confirmation-token": pendingConfirmation.token,
        },
      });

      const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
      const requestId = response.headers.get("X-Request-Id") ?? response.headers.get("x-request-id");
      const nextEntry: ResponseHistoryEntry = {
        id: historyIdRef.current++,
        operation: "execute",
        endpoint: "/agp/execute",
        requestBody: pendingConfirmation.requestBody,
        status: response.status,
        durationMs,
        requestId,
        data: response.data,
      };

      setHistory((current) => [nextEntry, ...current].slice(0, 5));
      setActiveHistoryId(nextEntry.id);

      // Check if the adapter returned its own pending_confirmation with a token
      const adapterToken = getConfirmationToken(response.data);
      if (adapterToken && response.ok) {
        setPendingAdapterToken({
          token: adapterToken,
          requestBody: confirmBody,
          businessId: pendingConfirmation.businessId,
          confirmHistoryId: nextEntry.id,
        });
      }
    } catch (error) {
      setActiveHistoryId(null);
      setRequestError(getErrorMessage(error, "Network request failed."));
    } finally {
      setPendingConfirmation(null);
      setIsConfirming(false);
    }
  }

  function clearHistory() {
    setHistory([]);
    setActiveHistoryId(null);
    setRequestError(null);
    setPendingConfirmation(null);
    setPendingAdapterToken(null);
  }

  async function handleSendAdapterToken() {
    if (!pendingAdapterToken || isSendingToken) {
      return;
    }

    setIsSendingToken(true);
    setRequestError(null);

    const startedAt = performance.now();

    try {
      // Send execute with the adapter-level confirmationToken in the request body
      let tokenBody: string;
      try {
        const parsed = JSON.parse(pendingAdapterToken.requestBody) as Record<string, unknown>;
        const request = (parsed.request ?? {}) as Record<string, unknown>;
        parsed.request = { ...request, confirmationToken: pendingAdapterToken.token };
        tokenBody = JSON.stringify(parsed);
      } catch {
        tokenBody = pendingAdapterToken.requestBody;
      }

      const response = await apiRawFetch<unknown>("/agp/execute", {
        method: "POST",
        body: tokenBody,
        headers: {
          "x-confirmation-token": pendingAdapterToken.token,
        },
      });

      const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
      const requestId = response.headers.get("X-Request-Id") ?? response.headers.get("x-request-id");
      const nextEntry: ResponseHistoryEntry = {
        id: historyIdRef.current++,
        operation: "execute",
        endpoint: "/agp/execute",
        requestBody: tokenBody,
        status: response.status,
        durationMs,
        requestId,
        data: response.data,
      };

      setHistory((current) => [nextEntry, ...current].slice(0, 5));
      setActiveHistoryId(nextEntry.id);
    } catch (error) {
      setActiveHistoryId(null);
      setRequestError(getErrorMessage(error, "Network request failed."));
    } finally {
      setPendingAdapterToken(null);
      setIsSendingToken(false);
    }
  }

  async function handleCopyResponse() {
    if (!displayedResponse) {
      return;
    }

    try {
      await navigator.clipboard.writeText(displayedResponseBody);
      setCopied(true);

      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }

      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetTimeoutRef.current = null;
      }, 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold text-app-text">API Playground</h1>
        <p className="text-sm text-app-text-subtle">
          Send AGP requests directly to runtime adapters and inspect full HTTP responses.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <div className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-2xl shadow-black/20">
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-app-text-muted">Config</h2>

            <div className="mt-4 space-y-4">
              <div className="space-y-2">
                <label htmlFor="adapter-select" className="text-xs font-medium uppercase tracking-[0.12em] text-app-text-subtle">
                  Adapter
                </label>

                <select
                  id="adapter-select"
                  value={selectedAdapter}
                  onChange={(event) => setSelectedAdapter(event.target.value)}
                  disabled={isLoadingAdapters || adapters.length === 0}
                  className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {adapters.length === 0 ? (
                    <option value="">{isLoadingAdapters ? "Loading adapters..." : "No adapters available"}</option>
                  ) : null}
                  {adapters.map((adapter) => (
                    <option key={adapter.platform} value={adapter.platform}>
                      {adapter.platform} ({adapter.status})
                    </option>
                  ))}
                </select>

                {selectedAdapterInfo ? (
                  <span
                    className={[
                      "inline-flex items-center rounded-md px-2 py-1 text-xs font-medium uppercase ring-1 ring-inset",
                      getAdapterStatusClass(selectedAdapterInfo.status),
                    ].join(" ")}
                  >
                    {selectedAdapterInfo.status}
                  </span>
                ) : null}

                {adapterError ? <p className="text-sm text-red-700 dark:text-red-300">{adapterError}</p> : null}
              </div>

              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-[0.12em] text-app-text-subtle">Operation</p>
                <div className="grid grid-cols-3 gap-2">
                  {OPERATIONS.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setOperation(item)}
                      className={[
                        "rounded-lg border px-3 py-2 text-sm font-medium capitalize transition",
                        operation === item
                          ? "border-blue-300 dark:border-blue-400/60 bg-blue-50 dark:bg-blue-500/20 text-blue-800 dark:text-blue-100"
                          : "border-app-border bg-app-input-bg text-app-text-muted hover:border-app-border-strong hover:text-app-text",
                      ].join(" ")}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {selectedAdapter ? (
            <div className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-2xl shadow-black/20">
              <button
                type="button"
                onClick={() => setIsHintsCollapsed((current) => !current)}
                className="flex w-full items-center justify-between gap-3 text-left"
              >
                <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-app-text-muted">Request Hints</h2>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                  className={[
                    "h-4 w-4 text-app-text-muted transition-transform",
                    isHintsCollapsed ? "" : "rotate-90",
                  ].join(" ")}
                >
                  <path d="M9 6L15 12L9 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {!isHintsCollapsed ? (
                <div className="mt-4 space-y-4">
                  {discoverLoading === selectedAdapter ? (
                    <p className="text-sm text-app-text-subtle">Loading hints...</p>
                  ) : selectedDiscoverError ? (
                    <p className="text-sm text-app-text-subtle">Unable to load request hints</p>
                  ) : selectedDiscoverData ? (
                    <>
                      {operation === "discover" ? (
                        <p className="text-sm text-app-text-subtle">No request body needed beyond businessId.</p>
                      ) : null}

                      {operation === "query" && queryHintExamples.length > 0 ? (
                        <div className="space-y-2">
                          <p className="text-xs font-medium uppercase tracking-[0.12em] text-app-text-subtle">Query Examples</p>
                          <div className="space-y-2">
                            {queryHintExamples.map(([label, example]) => (
                              <button
                                key={label}
                                type="button"
                                onClick={() => applyHintExample("query", example)}
                                className="w-full cursor-pointer rounded-lg border border-app-border bg-app-surface-alt p-3 text-left transition hover:bg-app-surface-soft"
                              >
                                <p className="mb-2 text-xs font-medium uppercase tracking-[0.08em] text-app-text-subtle">{label}</p>
                                <JsonHighlighter value={JSON.stringify(example, null, 2)} className="overflow-auto text-xs" />
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {operation === "execute" && executeHintExamples.length > 0 ? (
                        <div className="space-y-2">
                          <p className="text-xs font-medium uppercase tracking-[0.12em] text-app-text-subtle">Execute Examples</p>
                          <div className="space-y-2">
                            {executeHintExamples.map(([label, example]) => (
                              <button
                                key={label}
                                type="button"
                                onClick={() => applyHintExample("execute", example)}
                                className="w-full cursor-pointer rounded-lg border border-app-border bg-app-surface-alt p-3 text-left transition hover:bg-app-surface-soft"
                              >
                                <p className="mb-2 text-xs font-medium uppercase tracking-[0.08em] text-app-text-subtle">{label}</p>
                                <JsonHighlighter value={JSON.stringify(example, null, 2)} className="overflow-auto text-xs" />
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {operation === "execute" && discoverHints?.confirmationFlow ? (
                        <div className="rounded-lg border border-app-border bg-app-surface-alt p-3">
                          <p className="text-xs font-medium uppercase tracking-[0.08em] text-app-text-subtle">Confirmation Flow</p>
                          <p className="mt-1 text-sm text-app-text-subtle">{discoverHints.confirmationFlow}</p>
                        </div>
                      ) : null}

                      {operation === "execute" && simulationModeEntries.length > 0 ? (
                        <div className="rounded-lg border border-app-border bg-app-surface-alt p-3">
                          <p className="text-xs font-medium uppercase tracking-[0.08em] text-app-text-subtle">Simulation Modes</p>
                          <div className="mt-2 space-y-1">
                            {simulationModeEntries.map(([mode, details]) => (
                              <p key={mode} className="text-sm text-app-text-subtle">
                                <span className="font-medium text-app-text">{mode}:</span> {formatHintNote(details)}
                              </p>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {discoverServices.length > 0 ? (
                        <div className="space-y-2">
                          <p className="text-xs font-medium uppercase tracking-[0.12em] text-app-text-subtle">Services</p>
                          <div className="space-y-2">
                            {discoverServices.map((service, index) => {
                              const serviceName =
                                typeof service.name === "string" && service.name.trim().length > 0
                                  ? service.name
                                  : typeof service.id === "string" && service.id.trim().length > 0
                                    ? service.id
                                    : `Service ${index + 1}`;
                              const serviceDescription =
                                typeof service.description === "string" && service.description.trim().length > 0
                                  ? service.description
                                  : "No description provided.";

                              return (
                                <div key={`${serviceName}-${index}`} className="rounded-lg border border-app-border bg-app-surface-alt p-3">
                                  <p className="text-sm font-medium text-app-text">{serviceName}</p>
                                  <p className="mt-1 text-sm text-app-text-subtle">{serviceDescription}</p>
                                  <p className="mt-1 text-xs text-app-text-muted">
                                    {service.requiresConfirmation ? "Requires confirmation" : "No confirmation required"}
                                  </p>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-2xl shadow-black/20">
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-app-text-muted">Request</h2>

            <div className="mt-4 space-y-3">
              <textarea
                value={requestBody}
                onChange={handleRequestChange}
                onKeyDown={handleRequestKeyDown}
                spellCheck={false}
                rows={16}
                className={[
                  "w-full resize-y rounded-xl border bg-app-input-bg p-4 font-mono text-sm text-app-text outline-none transition focus:ring-2",
                  jsonError
                    ? "border-red-500/80 focus:border-red-400 focus:ring-red-500/30"
                    : "border-app-input-border focus:border-blue-400 focus:ring-blue-500/30",
                ].join(" ")}
              />

              {jsonError ? <p className="text-sm text-red-700 dark:text-red-300">{jsonError}</p> : <p className="text-sm text-app-text-subtle">Press Tab to insert 2 spaces.</p>}

              <button
                type="button"
                onClick={handleSendRequest}
                disabled={isSending || isConfirming}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400/50 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSending ? (
                  <>
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" className="opacity-20" stroke="currentColor" strokeWidth="3" />
                      <path
                        d="M22 12a10 10 0 0 0-10-10"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        className="opacity-90"
                      />
                    </svg>
                    Sending...
                  </>
                ) : (
                  "Send"
                )}
              </button>
            </div>
          </div>
        </div>

        <div className="flex min-h-[28rem] flex-col rounded-2xl border border-app-border bg-app-surface p-5 shadow-2xl shadow-black/20">
          <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-app-text-muted">Response</h2>

          <div className="mt-4 flex min-h-0 flex-1 flex-col rounded-xl border border-app-border bg-app-surface-alt">
            {displayedResponse ? (
              <>
                <div className="flex flex-wrap items-center gap-2 border-b border-app-border px-4 py-3 text-xs text-app-text-muted">
                  <span
                    className={[
                      "inline-flex items-center rounded-md px-2 py-1 font-semibold ring-1 ring-inset",
                      getStatusPillClass(displayedResponse.status),
                    ].join(" ")}
                  >
                    {displayedResponse.status}
                  </span>
                  <span className="rounded-md bg-app-muted-fill px-2 py-1 font-medium text-app-text-muted">{displayedResponse.durationMs} ms</span>
                  <span className="rounded-md bg-app-muted-fill px-2 py-1 text-app-text-muted">
                    Request ID: {displayedResponse.requestId ?? "n/a"}
                  </span>
                  <span className="rounded-md bg-app-muted-fill px-2 py-1 text-app-text-muted">{displayedResponse.endpoint}</span>
                  <span className="rounded-md bg-app-muted-fill px-2 py-1 uppercase text-app-text-muted">{displayedResponse.operation}</span>
                  <button
                    type="button"
                    title="Copy response"
                    aria-label="Copy response"
                    onClick={handleCopyResponse}
                    className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md border border-app-border bg-app-input-bg text-app-text-muted transition hover:border-app-border-strong hover:text-app-text focus:outline-none focus:ring-2 focus:ring-app-border"
                  >
                    {copied ? (
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
                        <path
                          d="M5 12.5L9.2 16.7L19 7"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
                        <rect x="9" y="9" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
                        <path
                          d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                </div>

                {pendingAdapterToken ? (
                  <div className="space-y-3 border-b border-app-border px-4 py-3">
                    <div className="rounded-lg border border-sky-300 bg-sky-50 p-3 dark:border-sky-400/50 dark:bg-sky-500/10">
                      <p className="text-sm font-medium text-sky-800 dark:text-sky-100">
                        Order ready. Review the summary below, then confirm to complete the purchase.
                      </p>
                      <p className="mt-1 font-mono text-xs text-sky-700 dark:text-sky-200">
                        Token: {pendingAdapterToken.token}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={handleSendAdapterToken}
                        disabled={isSendingToken}
                        className="inline-flex items-center gap-2 rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400/50 disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        {isSendingToken ? (
                          <>
                            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                              <circle cx="12" cy="12" r="10" className="opacity-20" stroke="currentColor" strokeWidth="3" />
                              <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-90" />
                            </svg>
                            Sending...
                          </>
                        ) : (
                          "Confirm \u0026 Pay"
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingAdapterToken(null)}
                        disabled={isSendingToken}
                        className="inline-flex items-center rounded-lg border border-app-border bg-app-input-bg px-4 py-2 text-sm font-medium text-app-text-muted transition hover:border-app-border-strong hover:text-app-text focus:outline-none focus:ring-2 focus:ring-app-border disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
                <JsonHighlighter value={displayedResponseBody} className="flex-1 overflow-auto p-4" />
              </>
            ) : requestError ? (
              <div className="flex flex-1 items-center justify-center p-6 text-center">
                <p className="text-sm text-red-700 dark:text-red-300">{requestError}</p>
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center p-6 text-center">
                <p className="text-sm text-app-text-subtle">Send a request to see the response here</p>
              </div>
            )}
          </div>

          {history.length > 0 ? (
            <div className="mt-4 space-y-3 border-t border-app-border pt-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-[0.12em] text-app-text-subtle">History</p>
                <button
                  type="button"
                  onClick={clearHistory}
                  className="rounded-md border border-app-border px-2 py-1 text-xs font-medium text-app-text-muted transition hover:border-app-border-strong hover:text-app-text"
                >
                  Clear history
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                {history.map((entry, index) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => {
                      setActiveHistoryId(entry.id);
                      setRequestError(null);
                    }}
                    className={[
                      "rounded-md border px-3 py-1.5 text-xs font-medium transition",
                      displayedResponse?.id === entry.id
                        ? "border-blue-400 dark:border-blue-400/70 bg-blue-50 dark:bg-blue-500/20 text-blue-800 dark:text-blue-100"
                        : "border-app-border bg-app-input-bg text-app-text-muted hover:border-app-border-strong hover:text-app-text",
                    ].join(" ")}
                  >
                    Request {history.length - index}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
