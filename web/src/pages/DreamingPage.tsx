import { useEffect, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type { DreamJobSnapshot, DreamProposal, DreamRunActionView, DreamRunRecord, DreamRunsResponse } from "../api/types";
import { DataTable } from "../components/DataTable";
import { Badge, Button, Card, CardBody, CardHeader, Chip, Drawer, Field, Input, KeyValue, Spinner, StatusDot } from "../components/primitives";
import { ErrorCard, RequireInstance, Skeleton } from "../components/states";
import { useToast } from "../components/Toast";
import { useAsync } from "../hooks/useAsync";
import { useDreamStream } from "../hooks/useDreamStream";
import { useInstances } from "../state/InstanceContext";
import { describeEvent } from "../lib/dream-progress";
import { formatCost, formatDateTime, formatRelative, titleCase } from "../lib/format";
import { jobStatusVariant, runStatusVariant } from "../lib/status";

/** Available dreaming tiers with descriptions. */
const TIERS: { id: "light" | "standard" | "deep"; label: string; hint: string }[] = [
  { id: "light", label: "Light", hint: "Fast deterministic upkeep" },
  { id: "standard", label: "Standard", hint: "Reconcile + project profile" },
  { id: "deep", label: "Deep", hint: "Full extract and synthesis" },
];

/**
 * Dreaming Runs page: launch maintenance runs and monitor live progress.
 *
 * @returns The rendered dreaming page.
 */
export function DreamingPage(): React.ReactElement {
  return (
    <RequireInstance>
      <DreamingInner />
    </RequireInstance>
  );
}

/** Dreaming content shown once an instance is confirmed selected. */
function DreamingInner(): React.ReactElement {
  const { selected } = useInstances();
  const toast = useToast();
  const [reloadToken, setReloadToken] = useState(0);
  const state = useAsync<DreamRunsResponse>(() => api.dreamRuns(), [selected?.record.id, reloadToken]);

  const [tier, setTier] = useState<"light" | "standard" | "deep">("light");
  const [apply, setApply] = useState(false);
  const [project, setProject] = useState("");
  const [starting, setStarting] = useState(false);
  const [activeJob, setActiveJob] = useState<DreamJobSnapshot | null>(null);
  const [detailRun, setDetailRun] = useState<DreamRunRecord | null>(null);

  const runningJob = activeJob ?? state.data?.jobs.find((job) => job.status === "running") ?? null;

  const start = async (): Promise<void> => {
    setStarting(true);
    try {
      const snapshot = await api.startDream({ tier, apply, project: project.trim() || undefined });
      setActiveJob(snapshot);
      toast.info("Dreaming run started", `${apply ? "Applying" : "Dry-run"} ${tier} pass.`);
    } catch (error) {
      toast.error("Could not start run", error instanceof ApiError ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  };

  const onFinished = (): void => {
    setReloadToken((value) => value + 1);
  };

  return (
    <div className="stack" style={{ gap: "var(--space-6)" }}>
      <div className="page-head">
        <div className="page-head__lead">
          <h2>Dreaming maintenance</h2>
          <p>Run background synthesis and reconciliation. Dry runs preview changes; apply runs mutate the corpus after a backup.</p>
        </div>
        <Button variant="ghost" icon="refresh" onClick={state.refetch}>
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader title="Launch a run" icon="dream" />
        <CardBody>
          <div className="stack" style={{ gap: "var(--space-5)" }}>
            <div className="row wrap" style={{ gap: "var(--space-6)", alignItems: "flex-start" }}>
              <div className="stack" style={{ gap: "var(--space-2)" }}>
                <span className="label">Tier</span>
                <div className="segmented">
                  {TIERS.map((option) => (
                    <button key={option.id} className={tier === option.id ? "is-active" : ""} onClick={() => setTier(option.id)}>
                      {option.label}
                    </button>
                  ))}
                </div>
                <span className="hint">{TIERS.find((option) => option.id === tier)?.hint}</span>
              </div>

              <div className="stack" style={{ gap: "var(--space-2)" }}>
                <span className="label">Mode</span>
                <div className="segmented">
                  <button className={!apply ? "is-active" : ""} onClick={() => setApply(false)}>
                    Dry run
                  </button>
                  <button className={apply ? "is-active" : ""} onClick={() => setApply(true)}>
                    Apply
                  </button>
                </div>
                <span className="hint">{apply ? "Mutates the corpus (backup taken first)" : "Preview only, no writes"}</span>
              </div>

              <div className="grow" style={{ minWidth: 200 }}>
                <Field label="Project scope" hint="Optional. Limits the run to one project.">
                  <Input placeholder="all projects" value={project} onChange={(event) => setProject(event.target.value)} />
                </Field>
              </div>
            </div>

            <div className="spread wrap" style={{ gap: "var(--space-3)" }}>
              <div className="row" style={{ gap: "var(--space-2)" }}>
                {apply ? <Badge status="warning">writes enabled</Badge> : <Badge status="info">safe preview</Badge>}
                {runningJob ? <Badge status="accent">a run is in progress</Badge> : null}
              </div>
              <Button variant={apply ? "primary" : "dream"} icon="play" loading={starting} disabled={Boolean(runningJob)} onClick={() => void start()}>
                {apply ? `Apply ${titleCase(tier)} run` : `Start ${titleCase(tier)} dry run`}
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      {runningJob ? <LiveRun job={runningJob} onFinished={onFinished} /> : null}

      <Card>
        <CardHeader title="Run history" icon="history" />
        <CardBody flush>
          {state.loading && !state.data ? (
            <div style={{ padding: "var(--space-5)" }}>
              <Skeleton height={160} />
            </div>
          ) : state.error ? (
            <div style={{ padding: "var(--space-5)" }}>
              <ErrorCard error={state.error} onRetry={state.refetch} />
            </div>
          ) : (
            <DataTable
              rows={state.data?.history ?? []}
              rowKey={(run) => run.id}
              onRowClick={(run) => setDetailRun(run)}
              empty={{ icon: "dream", title: "No runs recorded", message: "Start a dreaming run to populate history." }}
              columns={[
                { header: "Status", render: (run) => <Badge status={runStatusVariant(run.status)}>{titleCase(run.status)}</Badge> },
                { header: "Tier", render: (run) => <span className="secondary">{titleCase(run.tier)}</span> },
                { header: "Mode", render: (run) => <span className="muted">{run.dryRun ? "dry-run" : "applied"}</span> },
                { header: "Project", render: (run) => <span className="muted">{run.project ?? "all"}</span> },
                { header: "Actions", align: "right", render: (run) => <span className="numeric">{run.actionsTaken}</span> },
                { header: "Staled", align: "right", render: (run) => <span className="numeric muted">{run.durablesStaled}</span> },
                { header: "Cost", align: "right", render: (run) => <span className="numeric muted">{formatCost(run.estimatedCostUsd)}</span> },
                { header: "Started", align: "right", render: (run) => <span className="muted" title={formatDateTime(run.startedAt)}>{formatRelative(run.startedAt)}</span> },
              ]}
            />
          )}
        </CardBody>
      </Card>

      {detailRun ? <RunDetailDrawer run={detailRun} onClose={() => setDetailRun(null)} /> : null}
    </div>
  );
}

/** Live progress panel for an in-flight or just-finished job. */
function LiveRun({ job, onFinished }: { job: DreamJobSnapshot; onFinished: () => void }): React.ReactElement {
  const toast = useToast();
  const stream = useDreamStream(job.jobId, onFinished);
  const [cancelling, setCancelling] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const notified = useRef(false);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [stream.events.length]);

  useEffect(() => {
    if (stream.finished && !notified.current) {
      notified.current = true;
      if (stream.status === "completed") {
        toast.success("Dreaming run complete", "History updated with the latest run.");
      } else if (stream.status === "failed") {
        toast.error("Dreaming run failed", "See the run details for the error.");
      } else if (stream.status === "aborted") {
        toast.info("Dreaming run cancelled");
      }
    }
  }, [stream.finished, stream.status, toast]);

  const status = stream.status ?? job.status;
  const isRunning = status === "running" && !stream.finished;

  const cancel = async (): Promise<void> => {
    setCancelling(true);
    try {
      await api.cancelDream(job.jobId);
    } catch {
      // The terminal status event will reconcile the UI regardless.
    } finally {
      setCancelling(false);
    }
  };

  return (
    <Card raised>
      <CardHeader
        title={
          <span className="row" style={{ gap: "var(--space-2)" }}>
            <StatusDot status={jobStatusVariant(status)} pulse={isRunning} />
            Live run · {titleCase(job.tier)} {job.apply ? "apply" : "dry-run"}
          </span>
        }
        icon="bolt"
        actions={
          isRunning ? (
            <Button variant="danger" size="sm" icon="stop" loading={cancelling} onClick={() => void cancel()}>
              Cancel
            </Button>
          ) : (
            <Badge status={jobStatusVariant(status)}>{titleCase(status)}</Badge>
          )
        }
      />
      <CardBody>
        <div className="stack" style={{ gap: "var(--space-3)" }}>
          <div className="log" ref={logRef}>
            {stream.events.length === 0 ? (
              <div className="row" style={{ gap: "var(--space-2)", color: "var(--text-muted)" }}>
                <Spinner /> Waiting for the first progress update...
              </div>
            ) : (
              stream.events.map((event) => {
                const line = describeEvent(event);
                return (
                  <div className="log__line" key={event.seq}>
                    <span className="log__stage">{line.stage}</span>
                    <span className="log__msg">{line.message}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

/** Drawer showing a persisted run's actions and proposals. */
function RunDetailDrawer({ run, onClose }: { run: DreamRunRecord; onClose: () => void }): React.ReactElement {
  const actions = useAsync(() => api.runActions(run.id), [run.id]);
  const proposals = useAsync(() => api.runProposals(run.id), [run.id]);

  return (
    <Drawer
      title={
        <span className="row" style={{ gap: "var(--space-2)" }}>
          <StatusDot status={runStatusVariant(run.status)} />
          {titleCase(run.tier)} run
        </span>
      }
      subtitle={<span className="mono">{run.id}</span>}
      onClose={onClose}
    >
      <div className="stack" style={{ gap: "var(--space-5)" }}>
        <KeyValue
          rows={[
            { key: "Status", value: <Badge status={runStatusVariant(run.status)}>{titleCase(run.status)}</Badge> },
            { key: "Mode", value: run.dryRun ? "Dry run" : "Applied" },
            { key: "Project", value: run.project ?? "all" },
            { key: "Model", value: run.model ?? "-" },
            { key: "Actions taken", value: `${run.actionsTaken} (${run.actionsSkipped} skipped)` },
            { key: "Durables staled", value: String(run.durablesStaled) },
            { key: "Tokens", value: `${run.inputTokens.toLocaleString()} in / ${run.outputTokens.toLocaleString()} out` },
            { key: "Cost", value: formatCost(run.estimatedCostUsd) },
            { key: "Started", value: formatDateTime(run.startedAt) },
            { key: "Completed", value: run.completedAt ? formatDateTime(run.completedAt) : "-" },
          ]}
        />

        {run.error ? <div className="code-surface" style={{ color: "var(--danger)" }}>{run.error}</div> : null}

        <div className="stack" style={{ gap: "var(--space-3)" }}>
          <span className="section-title">Actions</span>
          {actions.loading ? (
            <Skeleton height={60} />
          ) : actions.data && actions.data.actions.length > 0 ? (
            <div className="stack" style={{ gap: "var(--space-2)" }}>
              {actions.data.actions.map((action) => (
                <div key={action.id} className="card" style={{ padding: "var(--space-3)" }}>
                  <div className="spread">
                    <Badge status="dream">{titleCase(action.actionType)}</Badge>
                    <span className="muted" style={{ fontSize: "var(--text-xs)" }}>{formatRelative(action.createdAt)}</span>
                  </div>
                  <p className="secondary" style={{ fontSize: "var(--text-sm)", marginTop: "var(--space-2)" }}>
                    {action.reasoning}
                  </p>
                  <DreamActionChangeSummary action={action} />
                </div>
              ))}
            </div>
          ) : (
            <span className="muted" style={{ fontSize: "var(--text-sm)" }}>No actions were recorded for this run.</span>
          )}
        </div>

        <div className="stack" style={{ gap: "var(--space-3)" }}>
          <span className="section-title">Proposals</span>
          {proposals.loading ? (
            <Skeleton height={60} />
          ) : proposals.data && proposals.data.proposals.length > 0 ? (
            <div className="stack" style={{ gap: "var(--space-2)" }}>
              {proposals.data.proposals.map((proposal: DreamProposal) => (
                <div key={proposal.id} className="card" style={{ padding: "var(--space-3)" }}>
                  <div className="spread">
                    <Badge status={proposal.reviewStatus === "applied" ? "success" : proposal.reviewStatus === "rejected" ? "neutral" : "warning"}>
                      {titleCase(proposal.reviewStatus)}
                    </Badge>
                    <span className="muted" style={{ fontSize: "var(--text-xs)" }}>{titleCase(proposal.issueKind)}</span>
                  </div>
                  <p className="secondary" style={{ fontSize: "var(--text-sm)", marginTop: "var(--space-2)" }}>
                    {proposal.rationale}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <span className="muted" style={{ fontSize: "var(--text-sm)" }}>No proposals were generated by this run.</span>
          )}
        </div>
      </div>
    </Drawer>
  );
}

/** Renders the concrete change payload for one dream action. */
function DreamActionChangeSummary({ action }: { action: DreamRunActionView }): React.ReactElement {
  const details = action.details ? Object.entries(action.details).filter(([, value]) => value !== null && value !== undefined && value !== "") : [];

  return (
    <div className="stack" style={{ gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
      {action.durableIds.length > 0 ? (
        <div className="row wrap" style={{ gap: "var(--space-2)" }}>
          <span className="muted" style={{ fontSize: "var(--text-xs)" }}>Affected</span>
          {action.durableIds.map((durableId) => (
            <Chip key={durableId} mono>{durableId}</Chip>
          ))}
        </div>
      ) : null}

      {details.length > 0 ? (
        <div className="change-grid">
          {details.map(([key, value]) => (
            <div key={key} style={{ display: "contents" }}>
              <span className="change-grid__key">{formatDetailKey(key)}</span>
              <span className="change-grid__value">{formatDetailValue(value)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {action.durables.length > 0 ? (
        <div className="stack" style={{ gap: "var(--space-2)" }}>
          {action.durables.map((durable) => (
            <div key={durable.id} className="change-item">
              <div className="spread" style={{ gap: "var(--space-2)" }}>
                <strong className="truncate" style={{ fontSize: "var(--text-xs)" }}>{durable.subject}</strong>
                {durable.claim_key ? <span className="mono muted" style={{ fontSize: "var(--text-2xs)" }}>{durable.claim_key}</span> : null}
              </div>
              <span className="muted truncate" style={{ fontSize: "var(--text-xs)" }}>{durable.content}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Formats an action detail key for compact display. */
function formatDetailKey(key: string): string {
  return key.replaceAll("_", " ");
}

/** Formats a structured action detail value for compact display. */
function formatDetailValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => formatDetailValue(entry)).join(", ");
  }

  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }

  return String(value);
}
