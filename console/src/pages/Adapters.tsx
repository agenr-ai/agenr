import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { apiFetch, fetchGenerationJobs, type ApiError, type GenerationJobRecord } from "../api/client";
import DataTable, { type Column } from "../components/DataTable";
import SourceModal from "../components/SourceModal";
import { useAuth } from "../context/AuthContext";
import { useRole } from "../context/RoleContext";
import { relativeTime } from "../utils/time";

type AdapterStatus = "sandbox" | "review" | "public" | "rejected" | "archived";
type JobStatus = "queued" | "running" | "complete" | "failed";
type JobSortColumn = "createdAt" | "completedAt" | "platform" | "status";
type JobSortDirection = "asc" | "desc";
type ActionTone = "neutral" | "blue" | "amber" | "cyan" | "red" | "emerald" | "rose" | "violet";

interface AdapterMeta {
  name?: string;
  description?: string;
  version?: string;
}

interface AdapterRecord {
  platform: string;
  status: AdapterStatus;
  owner: boolean;
  ownerId: string;
  adapterId: string;
  source: string;
  sourceCode?: string | null;
  meta?: AdapterMeta;
  reviewMessage?: string | null;
  submittedAt?: string | null;
  reviewedAt?: string | null;
  reviewFeedback?: string | null;
  archivedAt?: string | null;
}

interface ReviewRecord {
  adapterId: string;
  platform: string;
  ownerId: string;
  reviewMessage?: string | null;
  submittedAt?: string | null;
  reviewFeedback?: string | null;
  sourceCode?: string | null;
  meta?: AdapterMeta;
}

interface ReviewResponse {
  reviews: ReviewRecord[];
}

type GenerationJob = GenerationJobRecord;

interface GenerateAdapterResponse {
  jobId: string;
  platform: string;
  status: JobStatus;
  poll: string;
}

interface UploadAdapterResponse {
  adapterId: string;
  platform: string;
  status: "sandbox";
}

const ADAPTER_STATUS_FILTERS: AdapterStatus[] = ["sandbox", "review", "public", "rejected", "archived"];
const JOB_PAGE_SIZE = 25;

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
    if (error.status === 429) {
      return detail || "Rate limit reached. Wait a moment and retry.";
    }
    if (error.status >= 500) {
      return detail || "Server error. Try again in a few moments.";
    }

    return detail || fallback;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function adapterStatusClasses(status: AdapterStatus): string {
  if (status === "public") {
    return "border-emerald-300 dark:border-emerald-400/30 bg-emerald-50 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200";
  }
  if (status === "review") {
    return "border-amber-300 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200";
  }
  if (status === "rejected") {
    return "border-rose-300 dark:border-rose-400/30 bg-rose-50 dark:bg-rose-500/20 text-rose-700 dark:text-rose-200";
  }
  if (status === "archived") {
    return "border-app-border-strong bg-app-muted-fill text-app-text-muted";
  }
  return "border-yellow-300 dark:border-yellow-400/30 bg-yellow-50 dark:bg-yellow-500/20 text-yellow-700 dark:text-yellow-200";
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

function truncateText(value: string, maxLength = 64): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}...`;
}

function adapterRowKey(adapter: AdapterRecord): string {
  return `${adapter.platform}:${adapter.ownerId}:${adapter.status}`;
}

function latestAdapterUpdateAt(adapter: AdapterRecord): string | null {
  const candidates = [adapter.submittedAt, adapter.reviewedAt, adapter.archivedAt].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (candidates.length === 0) {
    return null;
  }

  let latest = candidates[0]!;
  for (const value of candidates.slice(1)) {
    if (Date.parse(value) > Date.parse(latest)) {
      latest = value;
    }
  }

  return latest;
}

export default function Adapters() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { activeRole } = useRole();
  const isAdmin = user?.isAdmin === true;
  const canAdmin = activeRole === "admin";
  const canDevelop = activeRole === "admin" || activeRole === "developer";

  const [adapters, setAdapters] = useState<AdapterRecord[]>([]);
  const [archivedAdapters, setArchivedAdapters] = useState<AdapterRecord[]>([]);
  const [isAdaptersLoading, setIsAdaptersLoading] = useState(true);
  const [adaptersError, setAdaptersError] = useState<string | null>(null);
  const [deletingAdapterKey, setDeletingAdapterKey] = useState<string | null>(null);
  const [hardDeletingKey, setHardDeletingKey] = useState<string | null>(null);
  const [statusFilters, setStatusFilters] = useState<Record<AdapterStatus, boolean>>({
    sandbox: true,
    review: true,
    public: true,
    rejected: true,
    archived: true,
  });

  const [platform, setPlatform] = useState("");
  const [docsUrl, setDocsUrl] = useState("");
  const [model, setModel] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [nextJobId, setNextJobId] = useState<string | null>(null);

  const [uploadPlatform, setUploadPlatform] = useState("");
  const [uploadDescription, setUploadDescription] = useState("");
  const [uploadSource, setUploadSource] = useState("");
  const [uploadFileName, setUploadFileName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isUploadDragOver, setIsUploadDragOver] = useState(false);
  const uploadFileInputRef = useRef<HTMLInputElement | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [actionInFlightKey, setActionInFlightKey] = useState<string | null>(null);

  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [isJobsLoading, setIsJobsLoading] = useState(true);
  const [isJobsLoadingMore, setIsJobsLoadingMore] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [jobsHasMore, setJobsHasMore] = useState(false);
  const [jobStatusFilter, setJobStatusFilter] = useState<JobStatus | "all">("all");
  const [jobSort, setJobSort] = useState<{ column: JobSortColumn; direction: JobSortDirection }>({
    column: "createdAt",
    direction: "desc",
  });

  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  const [isReviewsLoading, setIsReviewsLoading] = useState(false);
  const [reviewsError, setReviewsError] = useState<string | null>(null);

  const [sourceModal, setSourceModal] = useState<{ title: string; source: string } | null>(null);
  const [expandedAdapterKey, setExpandedAdapterKey] = useState<string | null>(null);

  const [rejectModal, setRejectModal] = useState<{ platform: string; ownerId: string } | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [isRejecting, setIsRejecting] = useState(false);
  const allAdapters = useMemo(
    () => (canAdmin ? [...adapters, ...archivedAdapters] : adapters),
    [adapters, archivedAdapters, canAdmin],
  );

  const filteredAdapters = useMemo(
    () => allAdapters.filter((adapter) => statusFilters[adapter.status] === true),
    [allAdapters, statusFilters],
  );

  const hasRunningJobs = useMemo(
    () => jobs.some((job) => job.status === "queued" || job.status === "running"),
    [jobs],
  );

  useEffect(() => {
    if (!expandedAdapterKey) {
      return;
    }

    const isStillVisible = filteredAdapters.some((adapter) => adapterRowKey(adapter) === expandedAdapterKey);
    if (!isStillVisible) {
      setExpandedAdapterKey(null);
    }
  }, [expandedAdapterKey, filteredAdapters]);

  const sortedJobs = useMemo(() => {
    const sorted = [...jobs];
    sorted.sort((left, right) => {
      let comparison = 0;

      if (jobSort.column === "platform") {
        comparison = left.platform.localeCompare(right.platform);
      } else if (jobSort.column === "status") {
        comparison = left.status.localeCompare(right.status);
      } else if (jobSort.column === "completedAt") {
        const leftTime = left.completedAt ? Date.parse(left.completedAt) : -Infinity;
        const rightTime = right.completedAt ? Date.parse(right.completedAt) : -Infinity;
        comparison = leftTime - rightTime;
      } else {
        comparison = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      }

      return jobSort.direction === "asc" ? comparison : -comparison;
    });

    return sorted;
  }, [jobSort, jobs]);

  const renderSortableJobHeader = useCallback(
    (label: string, column: JobSortColumn) => {
      const active = jobSort.column === column;
      const directionLabel = active && jobSort.direction === "asc" ? "ascending" : "descending";
      return (
        <button
          type="button"
          onClick={() =>
            setJobSort((current) => {
              if (current.column === column) {
                return {
                  column,
                  direction: current.direction === "asc" ? "desc" : "asc",
                };
              }

              return {
                column,
                direction: column === "platform" || column === "status" ? "asc" : "desc",
              };
            })
          }
          className={[
            "inline-flex items-center gap-1 transition",
            active ? "text-app-text-muted" : "text-app-text-subtle hover:text-app-text-muted",
          ].join(" ")}
          title={active ? `Sorted ${directionLabel}` : "Sort"}
        >
          {label}
          <span className="text-[10px] leading-none">{active ? (jobSort.direction === "asc" ? "▲" : "▼") : "↕"}</span>
        </button>
      );
    },
    [jobSort],
  );

  const jobColumns: Column<GenerationJob>[] = useMemo(
    () => [
      {
        key: "platform",
        header: renderSortableJobHeader("Platform", "platform"),
        className: "font-medium text-app-text",
        render: (job) => job.platform,
      },
      {
        key: "status",
        header: renderSortableJobHeader("Status", "status"),
        render: (job) => (
          <span
            className={[
              "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
              jobStatusClasses(job.status),
            ].join(" ")}
          >
            {job.status}
          </span>
        ),
      },
      {
        key: "createdAt",
        header: renderSortableJobHeader("Created", "createdAt"),
        className: "text-app-text-muted",
        render: (job) => relativeTime(job.createdAt),
      },
      {
        key: "completedAt",
        header: renderSortableJobHeader("Completed", "completedAt"),
        className: "text-app-text-muted",
        render: (job) => (job.completedAt ? relativeTime(job.completedAt) : "—"),
      },
      {
        key: "error",
        header: "Error",
        className: "text-app-text-muted",
        render: (job) =>
          job.error ? (
            <span title={job.error} className="text-red-700 dark:text-red-200">
              {truncateText(job.error)}
            </span>
          ) : (
            "—"
          ),
      },
    ],
    [renderSortableJobHeader],
  );

  const fetchAdapters = useCallback(async () => {
    setIsAdaptersLoading(true);
    setAdaptersError(null);

    try {
      const data = await apiFetch<AdapterRecord[]>("/adapters");
      setAdapters(data);
    } catch (error) {
      setAdaptersError(toApiErrorMessage(error, "Unable to load adapters right now."));
    } finally {
      setIsAdaptersLoading(false);
    }
  }, []);

  const fetchArchivedAdapters = useCallback(async () => {
    if (!canAdmin || !isAdmin) {
      setArchivedAdapters([]);
      return;
    }

    try {
      const data = await apiFetch<AdapterRecord[]>("/adapters/archived");
      setArchivedAdapters(data);
    } catch (error) {
      setAdaptersError(toApiErrorMessage(error, "Unable to load archived adapters."));
    }
  }, [canAdmin, isAdmin]);

  const fetchReviews = useCallback(async () => {
    if (!canAdmin) {
      setReviews([]);
      setReviewsError(null);
      return;
    }
    if (!isAdmin) {
      return;
    }

    setIsReviewsLoading(true);
    setReviewsError(null);

    try {
      const data = await apiFetch<ReviewResponse>("/adapters/reviews");
      setReviews(data.reviews ?? []);
    } catch (error) {
      setReviewsError(toApiErrorMessage(error, "Unable to load review queue."));
    } finally {
      setIsReviewsLoading(false);
    }
  }, [canAdmin, isAdmin]);

  async function handleDelete(platformName: string, ownerId: string) {
    const actionLabel = canAdmin ? "archive" : "remove";
    if (!confirm(`Are you sure you want to ${actionLabel} adapter "${platformName}"?`)) {
      return;
    }

    const deleteKey = `${platformName}:${ownerId}`;
    setDeletingAdapterKey(deleteKey);
    try {
      const query = canAdmin ? `?owner_id=${encodeURIComponent(ownerId)}` : "";
      await apiFetch(`/adapters/${encodeURIComponent(platformName)}${query}`, { method: "DELETE" });
      await refreshAfterMutation();
    } catch (error) {
      setAdaptersError(toApiErrorMessage(error, `Failed to ${actionLabel} ${platformName}.`));
    } finally {
      setDeletingAdapterKey(null);
    }
  }

  async function handleHardDelete(platformName: string, ownerId: string) {
    if (!confirm(`Permanently delete archived adapter "${platformName}"? This cannot be undone.`)) {
      return;
    }

    const key = `${platformName}:${ownerId}`;
    setHardDeletingKey(key);
    try {
      await apiFetch(
        `/adapters/${encodeURIComponent(platformName)}/hard?owner_id=${encodeURIComponent(ownerId)}`,
        { method: "DELETE" },
      );
      await refreshAfterMutation();
    } catch (error) {
      setAdaptersError(toApiErrorMessage(error, `Failed to permanently delete ${platformName}.`));
    } finally {
      setHardDeletingKey(null);
    }
  }

  const fetchJobs = useCallback(async (options?: { background?: boolean; append?: boolean; before?: string; beforeId?: string }) => {
    const background = options?.background === true;
    const append = options?.append === true;

    if (append) {
      setIsJobsLoadingMore(true);
    } else if (!background) {
      setIsJobsLoading(true);
    }
    if (!background) {
      setJobsError(null);
    }

    try {
      const data = await fetchGenerationJobs({
        status: jobStatusFilter === "all" ? undefined : jobStatusFilter,
        limit: JOB_PAGE_SIZE,
        before: options?.before,
        beforeId: options?.beforeId,
      });

      setJobs((previous) => {
        if (!append) {
          return data.jobs;
        }

        const seen = new Set(previous.map((job) => job.id));
        const next = data.jobs.filter((job) => !seen.has(job.id));
        return [...previous, ...next];
      });
      setJobsHasMore(data.has_more);
    } catch (error) {
      setJobsError(toApiErrorMessage(error, "Unable to load generation jobs."));
    } finally {
      if (append) {
        setIsJobsLoadingMore(false);
      } else if (!background) {
        setIsJobsLoading(false);
      }
    }
  }, [jobStatusFilter]);

  const refreshAfterMutation = useCallback(async () => {
    await fetchAdapters();
    await fetchArchivedAdapters();
    if (canAdmin) {
      await fetchReviews();
    }
  }, [canAdmin, fetchAdapters, fetchArchivedAdapters, fetchReviews]);

  useEffect(() => {
    void fetchAdapters();
    void fetchArchivedAdapters();
    void fetchReviews();
  }, [fetchAdapters, fetchArchivedAdapters, fetchReviews]);

  useEffect(() => {
    void fetchJobs({ background: false });
  }, [fetchJobs]);

  useEffect(() => {
    if (!nextJobId) {
      return;
    }

    const timer = window.setTimeout(() => {
      navigate(`/adapters/jobs/${encodeURIComponent(nextJobId)}`);
    }, 900);

    return () => {
      window.clearTimeout(timer);
    };
  }, [navigate, nextJobId]);

  useEffect(() => {
    if (!hasRunningJobs) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void fetchJobs({ background: true });
    }, 5_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [fetchJobs, hasRunningJobs]);

  function openUploadForPlatform(platformName: string): void {
    setUploadPlatform(platformName);
    setUploadError(null);
    setUploadSuccess(null);
    uploadFileInputRef.current?.click();
  }

  async function loadSourceFromFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      setUploadSource(text);
      setUploadFileName(file.name);
      setUploadError(null);
    } catch {
      setUploadError("Unable to read selected file.");
    }
  }

  async function handleUploadFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      await loadSourceFromFile(file);
    }
    event.target.value = "";
  }

  async function handleUploadDrop(event: DragEvent<HTMLDivElement>): Promise<void> {
    event.preventDefault();
    setIsUploadDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) {
      return;
    }
    await loadSourceFromFile(file);
  }

  async function handleGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);
    setSubmitSuccess(null);
    setNextJobId(null);

    const trimmedPlatform = platform.trim();
    const trimmedDocsUrl = docsUrl.trim();
    const trimmedModel = model.trim();

    if (!trimmedPlatform) {
      setSubmitError("Platform name is required.");
      return;
    }

    if (trimmedDocsUrl && !isValidUrl(trimmedDocsUrl)) {
      setSubmitError("Documentation URL must be a valid http(s) URL.");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await apiFetch<GenerateAdapterResponse>("/adapters/generate", {
        method: "POST",
        body: JSON.stringify({
          platform: trimmedPlatform,
          docsUrl: trimmedDocsUrl || undefined,
          model: trimmedModel || undefined,
        }),
      });

      setSubmitSuccess(`Generation queued. Job ID: ${response.jobId}`);
      setPlatform("");
      setDocsUrl("");
      setModel("");
      setNextJobId(response.jobId);
      await fetchJobs({ background: false });
      await refreshAfterMutation();
    } catch (error) {
      setSubmitError(toApiErrorMessage(error, "Unable to queue adapter generation."));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUploadError(null);
    setUploadSuccess(null);

    const platformName = uploadPlatform.trim().toLowerCase();
    if (!platformName) {
      setUploadError("Platform name is required.");
      return;
    }

    if (!uploadSource.trim()) {
      setUploadError("Adapter source is required.");
      return;
    }

    setIsUploading(true);

    try {
      const response = await apiFetch<UploadAdapterResponse>(`/adapters/${encodeURIComponent(platformName)}/upload`, {
        method: "POST",
        body: JSON.stringify({
          source: uploadSource,
          description: uploadDescription.trim() || undefined,
        }),
      });

      setUploadSuccess(`Uploaded ${response.platform} to sandbox.`);
      setUploadDescription("");
      setUploadFileName(null);
      await refreshAfterMutation();
    } catch (error) {
      setUploadError(toApiErrorMessage(error, "Unable to upload adapter source."));
    } finally {
      setIsUploading(false);
    }
  }

  async function runAction(key: string, action: () => Promise<void>, successMessage: string): Promise<void> {
    setActionError(null);
    setActionSuccess(null);
    setActionInFlightKey(key);

    try {
      await action();
      setActionSuccess(successMessage);
      await refreshAfterMutation();
    } catch (error) {
      setActionError(toApiErrorMessage(error, "Adapter action failed."));
    } finally {
      setActionInFlightKey(null);
    }
  }

  async function handleSubmitForReview(platformName: string): Promise<void> {
    const message = window.prompt("Optional review message", "") ?? "";
    await runAction(
      `submit:${platformName}`,
      async () => {
        await apiFetch(`/adapters/${encodeURIComponent(platformName)}/submit`, {
          method: "POST",
          body: JSON.stringify({ message: message.trim() || undefined }),
        });
      },
      `${platformName} submitted for review.`,
    );
  }

  async function handleWithdraw(platformName: string): Promise<void> {
    await runAction(
      `withdraw:${platformName}`,
      async () => {
        await apiFetch(`/adapters/${encodeURIComponent(platformName)}/withdraw`, {
          method: "POST",
        });
      },
      `${platformName} moved back to sandbox.`,
    );
  }

  async function handleApprove(platformName: string, ownerId: string): Promise<void> {
    await runAction(
      `approve:${platformName}:${ownerId}`,
      async () => {
        await apiFetch(`/adapters/${encodeURIComponent(platformName)}/promote?owner_id=${encodeURIComponent(ownerId)}`, {
          method: "POST",
        });
      },
      `${platformName} approved and promoted.`,
    );
  }

  async function handleDemote(platformName: string): Promise<void> {
    await runAction(
      `demote:${platformName}`,
      async () => {
        await apiFetch(`/adapters/${encodeURIComponent(platformName)}/demote`, {
          method: "POST",
        });
      },
      `${platformName} demoted to sandbox.`,
    );
  }


  async function handleRestore(platformName: string, ownerId: string): Promise<void> {
    await runAction(
      `restore:${platformName}:${ownerId}`,
      async () => {
        await apiFetch(`/adapters/${encodeURIComponent(platformName)}/restore?owner_id=${encodeURIComponent(ownerId)}`, {
          method: "POST",
        });
      },
      `${platformName} restored to sandbox.`,
    );
  }

  function openRejectModal(platformName: string, ownerId: string): void {
    setRejectModal({ platform: platformName, ownerId });
    setRejectReason("");
  }

  async function handleRejectSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!rejectModal) {
      return;
    }

    const reason = rejectReason.trim();
    if (!reason) {
      setActionError("Reject reason is required.");
      return;
    }

    setIsRejecting(true);
    setActionError(null);

    try {
      await apiFetch(
        `/adapters/${encodeURIComponent(rejectModal.platform)}/reject?owner_id=${encodeURIComponent(rejectModal.ownerId)}`,
        {
          method: "POST",
          body: JSON.stringify({ reason }),
        },
      );

      setRejectModal(null);
      setRejectReason("");
      setActionSuccess(`${rejectModal.platform} returned to sandbox with feedback.`);
      await refreshAfterMutation();
    } catch (error) {
      setActionError(toApiErrorMessage(error, "Unable to reject adapter."));
    } finally {
      setIsRejecting(false);
    }
  }

  function toggleStatusFilter(status: AdapterStatus): void {
    setStatusFilters((previous) => ({
      ...previous,
      [status]: !previous[status],
    }));
  }

  async function loadMoreJobs(): Promise<void> {
    const lastJob = jobs[jobs.length - 1];
    if (!lastJob || !jobsHasMore || isJobsLoadingMore) {
      return;
    }

    await fetchJobs({
      append: true,
      before: lastJob.createdAt,
      beforeId: lastJob.id,
    });
  }

  function actionButtonClasses(tone: ActionTone, compact: boolean): string {
    const size = compact ? "px-2 py-0.5 text-[11px]" : "px-3 py-1.5 text-xs";
    const toneClasses: Record<ActionTone, string> = {
      neutral: "border-app-border-strong text-app-text-muted hover:border-app-border-strong hover:bg-app-surface-soft",
      blue: "border-blue-300 dark:border-blue-400/20 text-blue-600 dark:text-blue-300 hover:border-blue-400 dark:hover:border-blue-400/50 hover:bg-blue-50 dark:hover:bg-blue-500/10 hover:text-blue-700 dark:hover:text-blue-200",
      amber: "border-amber-300 dark:border-amber-400/20 text-amber-700 dark:text-amber-200 hover:border-amber-400 dark:hover:border-amber-400/50 hover:bg-amber-50 dark:hover:bg-amber-500/10",
      cyan: "border-cyan-300 dark:border-cyan-400/20 text-cyan-700 dark:text-cyan-200 hover:border-cyan-400 dark:hover:border-cyan-400/50 hover:bg-cyan-50 dark:hover:bg-cyan-500/10",
      red: "border-red-300 dark:border-red-400/20 text-red-700 dark:text-red-300 hover:border-red-400 dark:hover:border-red-400/50 hover:bg-red-50 dark:hover:bg-red-500/10 hover:text-red-700 dark:hover:text-red-200",
      emerald: "border-emerald-300 dark:border-emerald-400/20 text-emerald-700 dark:text-emerald-200 hover:border-emerald-400 dark:hover:border-emerald-400/50 hover:bg-emerald-50 dark:hover:bg-emerald-500/10",
      rose: "border-rose-300 dark:border-rose-400/30 text-rose-700 dark:text-rose-200 hover:border-rose-400 dark:hover:border-rose-300 hover:bg-rose-50 dark:hover:bg-rose-500/10",
      violet: "border-violet-300 dark:border-violet-400/20 text-violet-700 dark:text-violet-200 hover:border-violet-400 dark:hover:border-violet-400/50 hover:bg-violet-50 dark:hover:bg-violet-500/10",
    };

    return `rounded-md border font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${size} ${toneClasses[tone]}`;
  }

  function renderActionButton(
    key: string,
    label: string,
    tone: ActionTone,
    onClick: () => void | Promise<void>,
    disabled: boolean,
    compact: boolean,
  ) {
    return (
      <button
        key={key}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          void onClick();
        }}
        disabled={disabled}
        className={actionButtonClasses(tone, compact)}
      >
        {label}
      </button>
    );
  }

  function renderAdapterActions(adapter: AdapterRecord, compact: boolean) {
    const inFlight = actionInFlightKey !== null;
    const isArchived = adapter.status === "archived";
    const deleteKey = `${adapter.platform}:${adapter.ownerId}`;
    const isDeleting = deletingAdapterKey === deleteKey;
    const isHardDeleting = hardDeletingKey === deleteKey;
    const ownerSandboxActions = adapter.owner && adapter.status === "sandbox" && canDevelop;

    const actions: Array<ReturnType<typeof renderActionButton>> = [];

    if (!isArchived) {
      actions.push(
        renderActionButton(
          `connect:${adapterRowKey(adapter)}`,
          "Connect",
          "blue",
          () => navigate(`/connections?service=${encodeURIComponent(adapter.platform)}`),
          false,
          compact,
        ),
      );
    }

    if (ownerSandboxActions) {
      actions.push(
        renderActionButton(
          `submit:${adapterRowKey(adapter)}`,
          "Submit for Review",
          "amber",
          () => handleSubmitForReview(adapter.platform),
          inFlight,
          compact,
        ),
      );
      actions.push(
        renderActionButton(
          `upload:${adapterRowKey(adapter)}`,
          "Upload",
          "cyan",
          () => openUploadForPlatform(adapter.platform),
          inFlight,
          compact,
        ),
      );
      actions.push(
        renderActionButton(
          `remove:${adapterRowKey(adapter)}`,
          isDeleting ? "Removing..." : "Remove",
          "red",
          () => handleDelete(adapter.platform, adapter.ownerId),
          isDeleting || inFlight,
          compact,
        ),
      );
    }

    if (canAdmin && !ownerSandboxActions && adapter.ownerId !== "system" && !isArchived) {
      actions.push(
        renderActionButton(
          `archive:${adapterRowKey(adapter)}`,
          isDeleting ? "Archiving..." : "Archive",
          "red",
          () => handleDelete(adapter.platform, adapter.ownerId),
          isDeleting || inFlight,
          compact,
        ),
      );
    }

    if (canAdmin && isArchived) {
      actions.push(
        renderActionButton(
          `restore:${adapterRowKey(adapter)}`,
          "Restore",
          "emerald",
          () => handleRestore(adapter.platform, adapter.ownerId),
          inFlight,
          compact,
        ),
      );
      actions.push(
        renderActionButton(
          `hard-delete:${adapterRowKey(adapter)}`,
          isHardDeleting ? "Deleting..." : "Delete Permanently",
          "rose",
          () => handleHardDelete(adapter.platform, adapter.ownerId),
          isHardDeleting || inFlight,
          compact,
        ),
      );
    }

    if (adapter.owner && adapter.status === "review" && canDevelop) {
      actions.push(
        renderActionButton(
          `withdraw:${adapterRowKey(adapter)}`,
          "Withdraw",
          "amber",
          () => handleWithdraw(adapter.platform),
          inFlight,
          compact,
        ),
      );
    }

    if (canAdmin && adapter.status === "review") {
      actions.push(
        renderActionButton(
          `approve:${adapterRowKey(adapter)}`,
          "Approve",
          "emerald",
          () => handleApprove(adapter.platform, adapter.ownerId),
          inFlight,
          compact,
        ),
      );
      actions.push(
        renderActionButton(
          `reject:${adapterRowKey(adapter)}`,
          "Reject",
          "red",
          () => openRejectModal(adapter.platform, adapter.ownerId),
          inFlight,
          compact,
        ),
      );
    }

    if (canAdmin && adapter.status === "public") {
      actions.push(
        renderActionButton(
          `demote:${adapterRowKey(adapter)}`,
          "Demote",
          "violet",
          () => handleDemote(adapter.platform),
          inFlight,
          compact,
        ),
      );
    }

    return actions;
  }

  const adapterColumns: Column<AdapterRecord>[] = useMemo(
    () => [
      {
        key: "platform",
        header: "Platform",
        className: "font-medium text-app-text",
        render: (adapter) => adapter.platform,
      },
      {
        key: "version",
        header: "Version",
        render: (adapter) => adapter.meta?.version || "—",
      },
      {
        key: "status",
        header: "Status",
        render: (adapter) => (
          <span
            className={[
              "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
              adapterStatusClasses(adapter.status),
            ].join(" ")}
          >
            {adapter.status === "review" ? "In Review" : adapter.status}
          </span>
        ),
      },
      {
        key: "owner",
        header: "Owner",
        render: (adapter) => {
          if (adapter.ownerId === "system") {
            return (
              <span className="rounded-full border border-app-border-strong bg-app-muted-fill px-2 py-0.5 text-xs font-medium text-app-text-muted">
                System
              </span>
            );
          }
          if (adapter.owner) {
            return (
              <span className="rounded-full border border-blue-300 dark:border-blue-400/30 bg-blue-50 dark:bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-200">
                You
              </span>
            );
          }

          const shortOwnerId = truncateText(adapter.ownerId, 18);
          return <span title={adapter.ownerId}>{shortOwnerId}</span>;
        },
      },
      {
        key: "updated",
        header: "Updated",
        render: (adapter) => {
          const latest = latestAdapterUpdateAt(adapter);
          return latest ? relativeTime(latest) : "—";
        },
      },
      {
        key: "actions",
        headerClassName: "text-right",
        header: "Actions",
        className: "w-[360px]",
        render: (adapter) => (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {renderAdapterActions(adapter, true)}
          </div>
        ),
      },
    ],
    [canAdmin, canDevelop, actionInFlightKey, deletingAdapterKey, hardDeletingKey, navigate],
  );

  function renderAdapterDetail(adapter: AdapterRecord) {
    const canViewSource = (canDevelop || adapter.owner) && Boolean(adapter.sourceCode);

    return (
      <div className="space-y-4">
        <div className="space-y-1">
          <p className="text-sm text-app-text">
            <span className="font-medium text-app-text-muted">Description:</span>{" "}
            {adapter.meta?.description || "No description provided."}
          </p>
          {adapter.status === "review" && adapter.reviewMessage ? (
            <p className="text-sm text-amber-700 dark:text-amber-200">
              <span className="font-medium text-amber-800 dark:text-amber-100">Review message:</span> {adapter.reviewMessage}
            </p>
          ) : null}
          {adapter.reviewFeedback ? (
            <p className="text-sm text-amber-800 dark:text-amber-100">
              <span className="font-medium text-amber-900 dark:text-amber-50">Review feedback:</span> {adapter.reviewFeedback}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canViewSource ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setSourceModal({
                  title: `${adapter.platform}.ts`,
                  source: adapter.sourceCode || "Source unavailable",
                });
              }}
              className="rounded-lg border border-app-border-strong px-3 py-1.5 text-xs font-medium text-app-text-muted transition hover:border-app-border-strong hover:bg-app-surface-soft"
            >
              View Source
            </button>
          ) : null}
          {renderAdapterActions(adapter, false)}
        </div>
      </div>
    );
  }

  return (
    <section className="space-y-8">
      <div>
        <h1 className="text-3xl font-semibold text-app-text">Adapters</h1>
        <p className="mt-2 text-app-text-subtle">Manage adapter lifecycle from sandbox to public.</p>
      </div>

      <section className="rounded-2xl border border-app-border bg-app-surface p-6 shadow-xl shadow-black/30">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-app-text">Adapter List</h2>
          <button
            type="button"
            onClick={() => void refreshAfterMutation()}
            disabled={isAdaptersLoading}
            className="rounded-lg border border-app-border-strong px-3 py-2 text-sm font-medium text-app-text-muted transition hover:border-blue-400 dark:hover:border-blue-400/60 hover:text-blue-700 dark:hover:text-blue-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isAdaptersLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {adaptersError ? <p className="mt-4 text-sm text-red-700 dark:text-red-300">{adaptersError}</p> : null}
        {actionError ? <p className="mt-4 text-sm text-red-700 dark:text-red-300">{actionError}</p> : null}
        {actionSuccess ? <p className="mt-4 text-sm text-emerald-600 dark:text-emerald-300">{actionSuccess}</p> : null}

        <div className="mt-4 rounded-xl border border-app-border bg-app-surface-soft p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-app-text-subtle">Status Filters</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(canAdmin ? ADAPTER_STATUS_FILTERS : ADAPTER_STATUS_FILTERS.filter((status) => status !== "archived")).map((status) => (
              <label
                key={status}
                className={[
                  "inline-flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-medium transition",
                  statusFilters[status]
                    ? "border-blue-300 dark:border-blue-400/40 bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200"
                    : "border-app-border-strong bg-app-surface-soft text-app-text-muted hover:border-app-border-strong",
                ].join(" ")}
              >
                <input
                  type="checkbox"
                  checked={statusFilters[status]}
                  onChange={() => toggleStatusFilter(status)}
                  className="h-3.5 w-3.5 rounded border-app-border-strong bg-app-surface-alt text-blue-400 focus:ring-blue-500/40"
                />
                <span>{status === "review" ? "review" : status}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <DataTable
            columns={adapterColumns}
            rows={filteredAdapters}
            rowKey={(adapter) => adapterRowKey(adapter)}
            loading={isAdaptersLoading}
            loadingMessage="Loading adapters..."
            emptyMessage="No adapters yet. Generate or upload one below."
            onRowClick={(adapter) => {
              const key = adapterRowKey(adapter);
              setExpandedAdapterKey((current) => (current === key ? null : key));
            }}
            expandedRowKey={expandedAdapterKey}
            renderExpandedRow={(adapter) => renderAdapterDetail(adapter)}
            rowClassName={(adapter) =>
              expandedAdapterKey === adapterRowKey(adapter)
                ? "bg-app-surface-soft hover:bg-app-surface-soft"
                : undefined
            }
          />
        </div>
      </section>

      {canAdmin ? (
        <section className="rounded-2xl border border-app-border bg-app-surface p-6 shadow-xl shadow-black/30">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-app-text">Reviews</h2>
            <button
              type="button"
              onClick={() => void fetchReviews()}
              disabled={isReviewsLoading}
              className="rounded-lg border border-app-border-strong px-3 py-2 text-sm font-medium text-app-text-muted transition hover:border-blue-400 dark:hover:border-blue-400/60 hover:text-blue-700 dark:hover:text-blue-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isReviewsLoading ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          {reviewsError ? <p className="mt-4 text-sm text-red-700 dark:text-red-300">{reviewsError}</p> : null}

          {isReviewsLoading ? (
            <p className="mt-4 text-sm text-app-text-subtle">Loading review queue...</p>
          ) : reviews.length === 0 ? (
            <p className="mt-4 text-sm text-app-text-subtle">No adapters pending review.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {reviews.map((review) => (
                <article key={`${review.platform}:${review.ownerId}`} className="rounded-xl border border-app-border bg-app-surface-soft p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-app-text">{review.platform}</p>
                      <p className="text-xs text-app-text-subtle">Submitter: {review.ownerId}</p>
                      {review.submittedAt ? <p className="text-xs text-app-text-subtle">Submitted {relativeTime(review.submittedAt)}</p> : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setSourceModal({
                            title: `${review.platform}.ts`,
                            source: review.sourceCode || "Source unavailable",
                          })
                        }
                        className="rounded-lg border border-app-border-strong px-2.5 py-1 text-xs font-medium text-app-text-muted transition hover:border-app-border-strong hover:bg-app-surface-soft"
                      >
                        View Source
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleApprove(review.platform, review.ownerId)}
                        className="rounded-lg border border-emerald-300 dark:border-emerald-400/20 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-200 transition hover:border-emerald-400 dark:hover:border-emerald-400/50 hover:bg-emerald-50 dark:hover:bg-emerald-500/10"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => openRejectModal(review.platform, review.ownerId)}
                        className="rounded-lg border border-red-300 dark:border-red-400/20 px-2.5 py-1 text-xs font-medium text-red-700 dark:text-red-300 transition hover:border-red-400 dark:hover:border-red-400/50 hover:bg-red-50 dark:hover:bg-red-500/10"
                      >
                        Reject
                      </button>
                    </div>
                  </div>

                  {review.reviewMessage ? <p className="mt-2 text-sm text-amber-700 dark:text-amber-200">"{review.reviewMessage}"</p> : null}
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {canDevelop ? (
        <section className="rounded-2xl border border-app-border bg-app-surface p-6 shadow-xl shadow-black/30">
          <h2 className="text-xl font-semibold text-app-text">Upload Adapter</h2>
          <p className="mt-2 text-sm text-app-text-subtle">Upload TypeScript adapter source directly to your sandbox.</p>

          {uploadSuccess ? (
            <div className="mt-4 rounded-lg border border-emerald-300 dark:border-emerald-400/30 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-200">
              {uploadSuccess}
            </div>
          ) : null}
          {uploadError ? (
            <div className="mt-4 rounded-lg border border-red-300 dark:border-red-400/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">
              {uploadError}
            </div>
          ) : null}

          <form className="mt-4 grid gap-4" onSubmit={(event) => void handleUpload(event)}>
            <div>
              <label htmlFor="uploadPlatform" className="mb-2 block text-sm font-medium text-app-text-muted">
                Platform name
              </label>
              <input
                id="uploadPlatform"
                name="uploadPlatform"
                type="text"
                placeholder="e.g. payment-platform-custom"
                value={uploadPlatform}
                onChange={(event) => setUploadPlatform(event.target.value)}
                disabled={isUploading}
                required
                className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-70"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-app-text-muted">Source file</label>
              <div
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsUploadDragOver(true);
                }}
                onDragLeave={() => setIsUploadDragOver(false)}
                onDrop={(event) => void handleUploadDrop(event)}
                className={[
                  "rounded-lg border border-dashed px-3 py-3 transition",
                  isUploadDragOver ? "border-cyan-300 bg-cyan-50 dark:bg-cyan-500/10" : "border-app-border-strong bg-app-surface-soft",
                ].join(" ")}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={uploadFileInputRef}
                    type="file"
                    accept=".ts,text/typescript"
                    onChange={(event) => void handleUploadFileChange(event)}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => uploadFileInputRef.current?.click()}
                    disabled={isUploading}
                    className="rounded-lg border border-cyan-300 dark:border-cyan-400/20 px-3 py-2 text-sm font-medium text-cyan-700 dark:text-cyan-200 transition hover:border-cyan-400 dark:hover:border-cyan-400/50 hover:bg-cyan-50 dark:hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Choose .ts File
                  </button>
                  <span className="text-xs text-app-text-subtle">{uploadFileName ?? "No file selected"}</span>
                </div>
                <p className="mt-2 text-xs text-app-text-subtle">Or drag and drop a `.ts` file here.</p>
              </div>
            </div>

            <div>
              <label htmlFor="uploadSource" className="mb-2 block text-sm font-medium text-app-text-muted">
                Source code
              </label>
              <textarea
                id="uploadSource"
                name="uploadSource"
                rows={12}
                value={uploadSource}
                onChange={(event) => setUploadSource(event.target.value)}
                disabled={isUploading}
                placeholder="Paste adapter source here"
                className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 font-mono text-xs text-app-text outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-70"
              />
            </div>

            <div>
              <label htmlFor="uploadDescription" className="mb-2 block text-sm font-medium text-app-text-muted">
                Description (optional)
              </label>
              <input
                id="uploadDescription"
                name="uploadDescription"
                type="text"
                value={uploadDescription}
                onChange={(event) => setUploadDescription(event.target.value)}
                disabled={isUploading}
                placeholder="Short summary for reviewers"
                className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-70"
              />
            </div>

            <div>
              <button
                type="submit"
                disabled={isUploading}
                className="inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-400/50 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isUploading ? "Uploading..." : "Upload Adapter"}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {canDevelop ? (
        <section className="rounded-2xl border border-app-border bg-app-surface p-6 shadow-xl shadow-black/30">
          <h2 className="text-xl font-semibold text-app-text">Generate New Adapter</h2>
          <p className="mt-2 text-sm text-app-text-subtle">Queue a generation job from platform docs and track progress below.</p>

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

          <form className="mt-4 grid gap-4" onSubmit={(event) => void handleGenerate(event)}>
            <div>
              <label htmlFor="platform" className="mb-2 block text-sm font-medium text-app-text-muted">
                Platform name
              </label>
              <input
                id="platform"
                name="platform"
                type="text"
                placeholder="e.g. platform-name"
                value={platform}
                onChange={(event) => setPlatform(event.target.value)}
                disabled={isSubmitting}
                required
                className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-70"
              />
            </div>

            <div>
              <label htmlFor="docsUrl" className="mb-2 block text-sm font-medium text-app-text-muted">
                Documentation URL
              </label>
              <input
                id="docsUrl"
                name="docsUrl"
                type="text"
                placeholder="https://docs.example.com/api"
                value={docsUrl}
                onChange={(event) => setDocsUrl(event.target.value)}
                disabled={isSubmitting}
                className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-70"
              />
            </div>

            <div>
              <label htmlFor="model" className="mb-2 block text-sm font-medium text-app-text-muted">
                Model
              </label>
              <input
                id="model"
                name="model"
                type="text"
                placeholder="e.g. gpt-5, claude-sonnet-4"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={isSubmitting}
                className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-70"
              />
            </div>

            <div>
              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400/50 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting ? (
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                ) : null}
                {isSubmitting ? "Generating..." : "Generate"}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="rounded-2xl border border-app-border bg-app-surface p-6 shadow-xl shadow-black/30">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-app-text">Generation Jobs</h2>
          <div className="text-xs text-app-text-subtle">
            {hasRunningJobs ? "Auto-refreshing every 5s while jobs are running." : "All jobs settled."}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-app-border bg-app-surface-soft p-3">
          <label className="flex items-center gap-2 text-xs text-app-text-muted">
            <span className="uppercase tracking-wide text-app-text-subtle">Status</span>
            <select
              value={jobStatusFilter}
              onChange={(event) => setJobStatusFilter(event.target.value as JobStatus | "all")}
              className="rounded-md border border-app-input-border bg-app-input-bg px-2 py-1 text-xs text-app-text-muted outline-none transition focus:border-blue-400"
            >
              <option value="all">All</option>
              <option value="queued">Queued</option>
              <option value="running">Running</option>
              <option value="complete">Complete</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          <p className="text-xs text-app-text-subtle">Click column headers to sort.</p>
        </div>
        <div className="mt-4">
          <DataTable
            columns={jobColumns}
            rows={sortedJobs}
            rowKey={(job) => job.id}
            loading={isJobsLoading}
            loadingMessage="Loading jobs..."
            emptyMessage="No generation jobs yet."
            error={jobsError}
            hasMore={jobsHasMore}
            loadingMore={isJobsLoadingMore}
            onLoadMore={() => void loadMoreJobs()}
            loadMoreLabel="Load More Jobs"
            onRowClick={(job) => navigate(`/adapters/jobs/${encodeURIComponent(job.id)}`)}
            rowClassName={() => "text-app-text-muted hover:bg-app-surface-soft focus-visible:bg-app-muted-fill"}
          />
        </div>
      </section>

      {sourceModal ? (
        <SourceModal title={sourceModal.title} sourceCode={sourceModal.source} onClose={() => setSourceModal(null)} />
      ) : null}

      {rejectModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-app-overlay px-4">
          <div className="w-full max-w-lg rounded-xl border border-app-border bg-app-surface p-5 shadow-2xl shadow-black/40">
            <h3 className="text-lg font-semibold text-app-text">Reject Adapter</h3>
            <p className="mt-2 text-sm text-app-text-subtle">
              Provide required feedback for {rejectModal.platform} ({rejectModal.ownerId}).
            </p>

            <form className="mt-4 space-y-4" onSubmit={(event) => void handleRejectSubmit(event)}>
              <textarea
                rows={5}
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                placeholder="Reason for rejection"
                disabled={isRejecting}
                className="w-full rounded-lg border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-500/30 disabled:cursor-not-allowed disabled:opacity-70"
              />

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRejectModal(null)}
                  disabled={isRejecting}
                  className="rounded-lg border border-app-border-strong px-3 py-2 text-sm font-medium text-app-text-muted transition hover:border-app-border-strong hover:bg-app-surface-soft disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isRejecting}
                  className="rounded-lg border border-red-300 dark:border-red-400/20 px-3 py-2 text-sm font-medium text-red-700 dark:text-red-200 transition hover:border-red-400 dark:hover:border-red-400/50 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isRejecting ? "Rejecting..." : "Reject"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}
