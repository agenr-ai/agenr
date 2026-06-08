import { runDreamRuntime } from "../dreaming/runtime.js";
import type { DreamProgressEvent } from "../dreaming/progress.js";
import type { DreamRunResult } from "../dreaming/service.js";
import type { DreamTier } from "../../core/dreaming/types.js";

/** Lifecycle status of a UI-started dreaming job. */
export type DreamJobStatus = "running" | "completed" | "failed" | "aborted";

/** Maximum progress events retained per job to bound memory. */
const MAX_EVENTS_PER_JOB = 500;

/** Maximum completed jobs retained before the oldest are evicted. */
const MAX_RETAINED_JOBS = 25;

/**
 * One ordered event in a dreaming job's live stream.
 *
 * `progress` events carry a structured pipeline update; `status` events mark a
 * lifecycle transition. The monotonic `seq` lets SSE clients resume without
 * gaps after a reconnect.
 */
export interface DreamJobEvent {
  /** Monotonic sequence number within the job. */
  seq: number;
  /** ISO timestamp the event was recorded. */
  at: string;
  /** Event discriminator. */
  kind: "progress" | "status";
  /** Structured progress payload for `progress` events. */
  progress?: DreamProgressEvent;
  /** Lifecycle status for `status` events. */
  status?: DreamJobStatus;
  /** Human-readable note for `status` events. */
  message?: string;
}

/**
 * Request accepted when starting a UI dreaming job.
 */
export interface StartDreamJobRequest {
  /** Run tier. */
  tier: DreamTier;
  /** When true, apply changes instead of a dry run. */
  apply: boolean;
  /** Optional project scope. */
  project?: string;
  /** Instance database path the run targets. */
  dbPath: string;
  /** Instance id the job is tagged with. */
  instanceId: string;
  /** Environment map forwarded to the dreaming runtime. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Public snapshot of one dreaming job suitable for JSON serialization.
 */
export interface DreamJobSnapshot {
  /** Stable job identifier assigned by the coordinator. */
  jobId: string;
  /** Instance id the job targets. */
  instanceId: string;
  /** Run tier. */
  tier: DreamTier;
  /** Whether the run applies changes. */
  apply: boolean;
  /** Optional project scope. */
  project: string | null;
  /** Current lifecycle status. */
  status: DreamJobStatus;
  /** ISO start timestamp. */
  startedAt: string;
  /** ISO completion timestamp, when finished. */
  completedAt: string | null;
  /** Persisted run id once the run resolves. */
  runId: string | null;
  /** Final run result, when completed. */
  result: DreamRunResult | null;
  /** Failure message, when failed. */
  error: string | null;
  /** Recorded event stream. */
  events: DreamJobEvent[];
}

/** Internal mutable job state held by the coordinator. */
interface DreamJob {
  snapshot: DreamJobSnapshot;
  abortController: AbortController;
  nextSeq: number;
  listeners: Set<(event: DreamJobEvent) => void>;
}

/**
 * Subscription handle returned when streaming a job's events.
 */
export interface DreamJobSubscription {
  /** Events already recorded at subscription time, for replay. */
  replay: DreamJobEvent[];
  /** Stops delivering further events to the listener. */
  unsubscribe(): void;
}

/**
 * In-process coordinator for UI-started dreaming runs.
 *
 * Owns the lifecycle of background runs the console launches: it threads a
 * progress reporter into the dreaming runtime, buffers events for reload-safe
 * replay, exposes a live subscription for SSE, and wires an abort signal so an
 * in-flight run can be cancelled. Persisted run history remains the source of
 * truth once a job completes; this coordinator only owns the live window.
 */
export class DreamingRunCoordinator {
  private readonly jobs = new Map<string, DreamJob>();
  private readonly order: string[] = [];

  /** Builds the dreaming runtime executor, allowing tests to inject a double. */
  public constructor(private readonly runtime: typeof runDreamRuntime = runDreamRuntime) {}

  /**
   * Starts a new dreaming job and runs it in the background.
   *
   * @param request - Run parameters and instance binding.
   * @returns Initial job snapshot in the `running` state.
   */
  public start(request: StartDreamJobRequest): DreamJobSnapshot {
    const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const abortController = new AbortController();
    const job: DreamJob = {
      snapshot: {
        jobId,
        instanceId: request.instanceId,
        tier: request.tier,
        apply: request.apply,
        project: request.project ?? null,
        status: "running",
        startedAt: new Date().toISOString(),
        completedAt: null,
        runId: null,
        result: null,
        error: null,
        events: [],
      },
      abortController,
      nextSeq: 0,
      listeners: new Set(),
    };

    this.jobs.set(jobId, job);
    this.order.push(jobId);
    this.evictOldJobs();
    this.recordStatus(job, "running", `Started ${request.apply ? "apply" : "dry-run"} ${request.tier} run.`);

    void this.execute(job, request);

    return cloneSnapshot(job.snapshot);
  }

  /**
   * Returns a snapshot of one job, or null when unknown.
   *
   * @param jobId - Job identifier.
   * @returns Cloned job snapshot, or null.
   */
  public getJob(jobId: string): DreamJobSnapshot | null {
    const job = this.jobs.get(jobId);
    return job ? cloneSnapshot(job.snapshot) : null;
  }

  /**
   * Lists retained job snapshots, newest first.
   *
   * @param instanceId - Optional instance filter.
   * @returns Cloned job snapshots.
   */
  public listJobs(instanceId?: string): DreamJobSnapshot[] {
    const snapshots = this.order
      .map((id) => this.jobs.get(id))
      .filter((job): job is DreamJob => job !== undefined)
      .map((job) => cloneSnapshot(job.snapshot));
    const filtered = instanceId ? snapshots.filter((snapshot) => snapshot.instanceId === instanceId) : snapshots;
    return filtered.reverse();
  }

  /**
   * Returns the active (running) job for an instance, when one exists.
   *
   * @param instanceId - Instance filter.
   * @returns Cloned running job snapshot, or null.
   */
  public getActiveJob(instanceId: string): DreamJobSnapshot | null {
    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const job = this.jobs.get(this.order[index]);
      if (job && job.snapshot.instanceId === instanceId && job.snapshot.status === "running") {
        return cloneSnapshot(job.snapshot);
      }
    }
    return null;
  }

  /**
   * Requests cancellation of an in-flight job.
   *
   * @param jobId - Job identifier.
   * @returns True when a running job was signaled to abort.
   */
  public cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.snapshot.status !== "running") {
      return false;
    }

    job.abortController.abort();
    return true;
  }

  /**
   * Subscribes to a job's event stream for SSE delivery.
   *
   * @param jobId - Job identifier.
   * @param listener - Callback invoked for each new event.
   * @returns Subscription with replay buffer and unsubscribe, or null.
   */
  public subscribe(jobId: string, listener: (event: DreamJobEvent) => void): DreamJobSubscription | null {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }

    job.listeners.add(listener);
    return {
      replay: [...job.snapshot.events],
      unsubscribe: () => {
        job.listeners.delete(listener);
      },
    };
  }

  /** Runs the dreaming pipeline for a job and records the terminal status. */
  private async execute(job: DreamJob, request: StartDreamJobRequest): Promise<void> {
    try {
      const result = await this.runtime({
        tier: request.tier,
        apply: request.apply,
        project: request.project,
        verbose: false,
        json: false,
        dbPath: request.dbPath,
        env: request.env,
        signal: job.abortController.signal,
        onProgress: (event) => this.recordProgress(job, event),
      });

      job.snapshot.runId = result.runId;
      job.snapshot.result = result;
      job.snapshot.completedAt = new Date().toISOString();
      this.recordStatus(job, "completed", `Run ${result.runId} ${result.status}.`);
    } catch (error) {
      job.snapshot.completedAt = new Date().toISOString();
      if (job.abortController.signal.aborted) {
        this.recordStatus(job, "aborted", "Run cancelled by operator.");
        return;
      }

      job.snapshot.error = error instanceof Error ? error.message : String(error);
      this.recordStatus(job, "failed", job.snapshot.error);
    }
  }

  /** Records one progress event and notifies subscribers. */
  private recordProgress(job: DreamJob, progress: DreamProgressEvent): void {
    this.appendEvent(job, { kind: "progress", progress });
  }

  /** Records one lifecycle status event and notifies subscribers. */
  private recordStatus(job: DreamJob, status: DreamJobStatus, message: string): void {
    job.snapshot.status = status;
    this.appendEvent(job, { kind: "status", status, message });
  }

  /** Appends an event, bounds the buffer, and notifies live listeners. */
  private appendEvent(job: DreamJob, partial: Omit<DreamJobEvent, "seq" | "at">): void {
    const event: DreamJobEvent = {
      seq: job.nextSeq,
      at: new Date().toISOString(),
      ...partial,
    };
    job.nextSeq += 1;
    job.snapshot.events.push(event);
    if (job.snapshot.events.length > MAX_EVENTS_PER_JOB) {
      job.snapshot.events.splice(0, job.snapshot.events.length - MAX_EVENTS_PER_JOB);
    }

    for (const listener of job.listeners) {
      try {
        listener(event);
      } catch {
        // A failing subscriber must never break the run.
      }
    }
  }

  /** Evicts the oldest completed jobs once the retention cap is exceeded. */
  private evictOldJobs(): void {
    while (this.order.length > MAX_RETAINED_JOBS) {
      const candidateId = this.order.find((id) => {
        const job = this.jobs.get(id);
        return job !== undefined && job.snapshot.status !== "running";
      });
      if (!candidateId) {
        return;
      }

      this.jobs.delete(candidateId);
      this.order.splice(this.order.indexOf(candidateId), 1);
    }
  }
}

/** Deep-clones a job snapshot so callers cannot mutate coordinator state. */
function cloneSnapshot(snapshot: DreamJobSnapshot): DreamJobSnapshot {
  return {
    ...snapshot,
    events: snapshot.events.map((event) => ({ ...event })),
    result: snapshot.result ? { ...snapshot.result } : null,
  };
}
