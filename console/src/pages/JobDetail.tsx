import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { apiFetch, type ApiError } from "../api/client";

type JobStatus = "queued" | "running" | "complete" | "failed";

interface JobRuntime {
  provider: string;
  model: string;
}

interface JobResult {
  adapterPath: string;
  profilePath: string;
  attempts: number;
  runtime?: JobRuntime | null;
}

interface GenerationJobDetail {
  id: string;
  platform: string;
  docsUrl: string | null;
  provider: string | null;
  model: string | null;
  status: JobStatus;
  ownerKeyId: string;
  logs: string[];
  result: JobResult | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
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

    if (error.status >= 500) {
      return detail || "Server error. Retrying in the background.";
    }

    return detail || fallback;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "—";
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }

  return dateTimeFormatter.format(parsed);
}

function jobStatusClasses(status: JobStatus): string {
  if (status === "queued") {
    return "border-app-border-strong bg-app-muted-fill text-app-text-muted";
  }
  if (status === "running") {
    return "animate-pulse border-blue-300 dark:border-blue-400/30 bg-blue-50 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200";
  }
  if (status === "complete") {
    return "border-emerald-300 dark:border-emerald-400/30 bg-emerald-50 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200";
  }
  return "border-red-300 dark:border-red-400/30 bg-red-50 dark:bg-red-500/20 text-red-700 dark:text-red-200";
}

function isActiveStatus(status: JobStatus): boolean {
  return status === "queued" || status === "running";
}

function normalizeJob(data: GenerationJobDetail): GenerationJobDetail {
  return {
    ...data,
    docsUrl: data.docsUrl || null,
    provider: data.provider || null,
    model: data.model || null,
    logs: Array.isArray(data.logs) ? data.logs.map((line) => String(line)) : [],
    error: data.error || null,
    startedAt: data.startedAt || null,
    completedAt: data.completedAt || null,
    result: data.result
      ? {
          ...data.result,
          runtime: data.result.runtime
            ? {
                provider: data.result.runtime.provider,
                model: data.result.runtime.model,
              }
            : null,
        }
      : null,
  };
}

function isUnchanged(prev: GenerationJobDetail, next: GenerationJobDetail): boolean {
  return (
    prev.id === next.id &&
    prev.platform === next.platform &&
    prev.docsUrl === next.docsUrl &&
    prev.provider === next.provider &&
    prev.model === next.model &&
    prev.status === next.status &&
    prev.ownerKeyId === next.ownerKeyId &&
    prev.logs.length === next.logs.length &&
    prev.createdAt === next.createdAt &&
    prev.startedAt === next.startedAt &&
    prev.completedAt === next.completedAt &&
    prev.error === next.error &&
    prev.result?.attempts === next.result?.attempts &&
    prev.result?.runtime?.provider === next.result?.runtime?.provider &&
    prev.result?.runtime?.model === next.result?.runtime?.model
  );
}

export default function JobDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const logsRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const previousLogLengthRef = useRef(0);

  const [job, setJob] = useState<GenerationJobDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  const fetchJob = useCallback(
    async (background = false) => {
      if (!id) {
        setNotFound(true);
        setIsLoading(false);
        return;
      }

      if (!background) {
        setIsLoading(true);
        setLoadError(null);
      }

      try {
        const data = await apiFetch<GenerationJobDetail>(`/adapters/jobs/${encodeURIComponent(id)}`);
        const normalized = normalizeJob(data);

        setNotFound(false);
        setLoadError(null);
        setPollError(null);
        setJob((previous) => {
          if (previous && isUnchanged(previous, normalized)) {
            return previous;
          }
          return normalized;
        });
      } catch (error) {
        if (isApiError(error) && error.status === 404) {
          setNotFound(true);
          setLoadError(null);
          setPollError(null);
          setJob(null);
          return;
        }

        const message = toApiErrorMessage(error, "Unable to load this job right now.");
        if (background) {
          setPollError(message);
        } else {
          setLoadError(message);
        }
      } finally {
        if (!background) {
          setIsLoading(false);
        }
      }
    },
    [id],
  );

  useEffect(() => {
    shouldAutoScrollRef.current = true;
    previousLogLengthRef.current = 0;
  }, [id]);

  useEffect(() => {
    void fetchJob();
  }, [fetchJob]);

  useEffect(() => {
    const status = job?.status;
    if (!status || !isActiveStatus(status) || notFound) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void fetchJob(true);
    }, 2_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [fetchJob, job?.status, notFound]);

  useEffect(() => {
    const nextLength = job?.logs.length ?? 0;
    const previousLength = previousLogLengthRef.current;
    const hasNewEntries = nextLength > previousLength;
    previousLogLengthRef.current = nextLength;

    if (!hasNewEntries || !shouldAutoScrollRef.current) {
      return;
    }

    const container = logsRef.current;
    if (!container) {
      return;
    }

    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth",
    });
  }, [job?.logs.length]);

  function handleLogsScroll() {
    const container = logsRef.current;
    if (!container) {
      return;
    }

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom <= 24;
  }

  if (notFound || (!id && !isLoading)) {
    return (
      <section className="space-y-6">
        <Link to="/adapters" className="inline-flex text-sm font-medium text-blue-700 dark:text-blue-200 hover:text-blue-700 dark:hover:text-blue-100">
          {"< Back to Adapters"}
        </Link>
        <div className="rounded-2xl border border-red-300 dark:border-red-500/20 bg-red-50 dark:bg-red-500/10 p-6">
          <h1 className="text-2xl font-semibold text-app-text">Job not found</h1>
          <p className="mt-2 text-sm text-red-800/90 dark:text-red-100/90">This generation job does not exist or is no longer available.</p>
        </div>
      </section>
    );
  }

  if (isLoading && !job) {
    return (
      <section className="space-y-4">
        <p className="text-sm text-app-text-subtle">Loading job details...</p>
      </section>
    );
  }

  if (loadError && !job) {
    return (
      <section className="space-y-6">
        <Link to="/adapters" className="inline-flex text-sm font-medium text-blue-700 dark:text-blue-200 hover:text-blue-700 dark:hover:text-blue-100">
          {"< Back to Adapters"}
        </Link>
        <div className="rounded-2xl border border-red-300 dark:border-red-500/20 bg-red-50 dark:bg-red-500/10 p-6">
          <h1 className="text-2xl font-semibold text-app-text">Unable to load job</h1>
          <p className="mt-2 text-sm text-red-800/90 dark:text-red-100/90">{loadError}</p>
          <button
            type="button"
            onClick={() => void fetchJob()}
            className="mt-4 rounded-lg border border-app-border-strong px-3 py-2 text-sm font-medium text-app-text transition hover:border-blue-400 dark:hover:border-blue-400/60 hover:text-blue-700 dark:hover:text-blue-200"
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (!job) {
    return null;
  }

  const resultProvider = job.result?.runtime?.provider ?? job.provider ?? "unknown";
  const resultModel = job.result?.runtime?.model ?? job.model ?? "unknown";

  return (
    <section className="space-y-6">
      <header className="space-y-3">
        <Link to="/adapters" className="inline-flex text-sm font-medium text-blue-700 dark:text-blue-200 hover:text-blue-700 dark:hover:text-blue-100">
          {"< Back to Adapters"}
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold text-app-text">Generating {job.platform} adapter</h1>
            <p className="font-mono text-xs text-app-text-subtle">Job ID: {job.id}</p>
          </div>
          <span
            className={[
              "inline-flex rounded-full border px-3 py-1 text-xs font-medium uppercase tracking-wide",
              jobStatusClasses(job.status),
            ].join(" ")}
          >
            {job.status}
          </span>
        </div>
      </header>

      <section className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-xl shadow-black/30">
        <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-app-text-muted">Job Metadata</h2>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-wide text-app-text-subtle">Platform</dt>
            <dd className="mt-1 text-app-text">{job.platform}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-app-text-subtle">Docs URL</dt>
            <dd className="mt-1 break-all">
              {job.docsUrl ? (
                <a
                  href={job.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 dark:text-blue-300 underline decoration-blue-400/40 underline-offset-2 hover:text-blue-700 dark:hover:text-blue-200"
                >
                  {job.docsUrl}
                </a>
              ) : (
                <span className="text-app-text-subtle">—</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-app-text-subtle">Provider</dt>
            <dd className="mt-1 text-app-text">{job.provider ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-app-text-subtle">Model</dt>
            <dd className="mt-1 text-app-text">{job.model ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-app-text-subtle">Created</dt>
            <dd className="mt-1 text-app-text">{formatTimestamp(job.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-app-text-subtle">Started</dt>
            <dd className="mt-1 text-app-text">{formatTimestamp(job.startedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-app-text-subtle">Completed</dt>
            <dd className="mt-1 text-app-text">{formatTimestamp(job.completedAt)}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-xl shadow-black/30">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-app-text">Generation Logs</h2>
          <p className="text-xs text-app-text-subtle">
            {isActiveStatus(job.status) ? "Polling every 2s" : "Job settled"}
          </p>
        </div>

        {pollError ? (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-300">Polling issue: {pollError} Retrying automatically.</p>
        ) : null}

        <div className="mt-3 rounded-xl border border-app-border bg-app-surface-alt">
          <div
            ref={logsRef}
            onScroll={handleLogsScroll}
            className="max-h-[27rem] overflow-y-auto px-4 py-3 font-mono text-sm leading-6 text-app-text-muted"
          >
            {job.logs.length === 0 ? (
              isActiveStatus(job.status) ? (
                <div className="flex items-center gap-2 text-app-text-subtle">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500 dark:bg-blue-300" />
                  Waiting for logs...
                </div>
              ) : (
                <p className="text-app-text-subtle">No logs were recorded for this job.</p>
              )
            ) : (
              <ol className="space-y-1">
                {job.logs.map((entry, index) => (
                  <li key={`${index}`} className="flex items-start gap-4">
                    <span className="w-8 shrink-0 select-none text-right text-xs text-app-text-subtle">
                      {String(index + 1).padStart(3, "0")}
                    </span>
                    <span className="whitespace-pre-wrap break-words text-app-text">{entry}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </section>

      {job.status === "complete" && job.result ? (
        <section className="rounded-2xl border border-emerald-300 dark:border-emerald-400/30 bg-emerald-50 dark:bg-emerald-500/10 p-5">
          <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-200">Adapter generated successfully</h2>
          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
            <p className="text-emerald-800/90 dark:text-emerald-100/90">
              <span className="block text-xs uppercase tracking-wide text-emerald-700/80 dark:text-emerald-300/80">Attempts</span>
              {job.result.attempts}
            </p>
            <p className="text-emerald-800/90 dark:text-emerald-100/90">
              <span className="block text-xs uppercase tracking-wide text-emerald-700/80 dark:text-emerald-300/80">Provider Used</span>
              {resultProvider}
            </p>
            <p className="text-emerald-800/90 dark:text-emerald-100/90">
              <span className="block text-xs uppercase tracking-wide text-emerald-700/80 dark:text-emerald-300/80">Model Used</span>
              {resultModel}
            </p>
          </div>
          <Link
            to="/adapters"
            className="mt-4 inline-flex rounded-lg border border-emerald-300 dark:border-emerald-300/30 px-3 py-2 text-sm font-medium text-emerald-800 dark:text-emerald-100 transition hover:border-emerald-400 dark:hover:border-emerald-200/50 hover:text-app-text"
          >
            View in Adapter Explorer
          </Link>
        </section>
      ) : null}

      {job.status === "failed" ? (
        <section className="rounded-2xl border border-red-300 dark:border-red-400/30 bg-red-50 dark:bg-red-500/10 p-5">
          <h2 className="text-lg font-semibold text-red-700 dark:text-red-200">Generation failed</h2>
          <pre className="mt-3 overflow-x-auto rounded-lg border border-red-300 dark:border-red-400/20 bg-app-surface-alt p-3 font-mono text-xs leading-6 text-red-800 dark:text-red-100">
            {job.error?.trim() || "Unknown generation error."}
          </pre>
          <button
            type="button"
            onClick={() => navigate("/adapters")}
            className="mt-4 rounded-lg border border-app-border-strong px-3 py-2 text-sm font-medium text-app-text transition hover:border-red-400 dark:hover:border-red-300/70 hover:text-red-700 dark:hover:text-red-100"
          >
            Try Again
          </button>
        </section>
      ) : null}
    </section>
  );
}
