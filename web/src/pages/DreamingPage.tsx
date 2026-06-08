import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

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
import { formatCost, formatDateTime, formatDateTimeWithRelative, formatPercent, formatRelative, titleCase } from "../lib/format";
import { jobStatusVariant, runStatusVariant } from "../lib/status";

/** Available dreaming tiers with descriptions. */
const TIERS: { id: "light" | "standard" | "deep"; label: string; hint: string }[] = [
  { id: "light", label: "Light", hint: "Fast deterministic upkeep" },
  { id: "standard", label: "Standard", hint: "Reconcile + project profile" },
  { id: "deep", label: "Deep", hint: "Full extract and synthesis" },
];

/** UUID text emitted by storage-level audit payloads. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** UUID fragments embedded inside storage-level audit prose. */
const UUID_IN_TEXT_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;

/** Detail field labels for operator-facing dream action payloads. */
const DETAIL_KEY_LABELS: Record<string, string> = {
  claim_key: "Claim key",
  evidence_refs: "Evidence",
  predecessor_id: "Previous durable",
  successor_id: "Replacement durable",
  valid_to: "Valid until",
};

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
  const navigate = useNavigate();
  const actions = useAsync(() => api.runActions(run.id), [run.id]);
  const proposals = useAsync(() => api.runProposals(run.id), [run.id]);

  return (
    <Drawer
      title={
        <span className="row" style={{ gap: "var(--space-2)" }}>
          <StatusDot status={runStatusVariant(run.status)} />
          {titleCase(run.tier)} {run.dryRun ? "dry run" : "applied run"}
        </span>
      }
      subtitle={<span>{formatDateTimeWithRelative(run.startedAt)}</span>}
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
              {actions.data.actions.map((action) => {
                const durableById = new Map(action.durables.map((durable) => [durable.id, durable]));
                return (
                  <div key={action.id} className="card" style={{ padding: "var(--space-3)" }}>
                    <div className="spread">
                      <Badge status={action.actionType === "flag_review" ? "warning" : "dream"}>{formatActionTypeLabel(action.actionType)}</Badge>
                      <span className="muted" style={{ fontSize: "var(--text-xs)" }} title={formatDateTimeWithRelative(action.createdAt)}>
                        {formatDateTime(action.createdAt)}
                      </span>
                    </div>
                    {action.actionType === "flag_review" ? (
                      <FlagReviewActionSummary action={action} onOpenProposals={() => navigate("/proposals")} />
                    ) : (
                      <>
                        <p className="secondary" style={{ fontSize: "var(--text-sm)", marginTop: "var(--space-2)" }} title={action.reasoning}>
                          {formatActionReasoning(action.reasoning, action.details, durableById)}
                        </p>
                        <DreamActionChangeSummary action={action} />
                      </>
                    )}
                  </div>
                );
              })}
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

/** Plain-language summary for a proposal staged for human review. */
function FlagReviewActionSummary({ action, onOpenProposals }: { action: DreamRunActionView; onOpenProposals: () => void }): React.ReactElement {
  const details = action.details ?? {};
  const currentClaimKeys = readStringArrayDetail(details.current_claim_keys);
  const proposedClaimKeys = readStringArrayDetail(details.proposed_claim_keys);
  const confidence = typeof details.confidence === "number" ? details.confidence : null;
  const eligibleForApply = details.eligible_for_apply === true;
  const blocker = typeof details.auto_apply_blocker === "string" ? details.auto_apply_blocker : null;
  const durableById = new Map(action.durables.map((durable) => [durable.id, durable]));

  return (
    <div className="review-summary">
      <div className="review-summary__plain">
        <strong>Dreaming found a suggested claim-key change.</strong>
        <span>
          Review means deciding whether the affected memory belongs under the proposed key. Apply writes that key after a backup; reject leaves the
          memory unchanged and records the reason.
        </span>
      </div>

      <div className="review-summary__grid">
        <ReviewSummaryRow label="Current key" value={formatClaimKeyList(currentClaimKeys, "(no current key)")} />
        <ReviewSummaryRow label="Proposed key" value={formatClaimKeyList(proposedClaimKeys, "(no proposed key)")} emphasized />
        {confidence !== null ? <ReviewSummaryRow label="Confidence" value={formatPercent(confidence)} /> : null}
        <ReviewSummaryRow label="Decision" value={formatReviewDecisionText(eligibleForApply, blocker)} />
      </div>

      <div className="stack" style={{ gap: "var(--space-2)" }}>
        <span className="section-title">What to check</span>
        <ul className="review-checklist">
          <li>The memory text is really about the proposed topic.</li>
          <li>The proposed key describes the stable slot this memory should be grouped under.</li>
          <li>Applying the key would group it with the right related memories, not just similar wording.</li>
        </ul>
      </div>

      <ReviewEvidenceSummary details={details} />

      {action.durableIds.length > 0 ? (
        <div className="row wrap" style={{ gap: "var(--space-2)" }}>
          <span className="muted" style={{ fontSize: "var(--text-xs)" }}>Affected</span>
          {action.durableIds.map((durableId) => (
            <Chip key={durableId} className="chip--compact" title={formatAffectedDurableReferenceTitle(durableId, action.details, durableById)}>
              <span className="truncate">{formatAffectedDurableReference(durableId, action.details, durableById)}</span>
            </Chip>
          ))}
        </div>
      ) : null}

      {action.durables.length > 0 ? <ActionDurableList action={action} /> : null}

      <div className="row" style={{ justifyContent: "space-between", gap: "var(--space-3)" }}>
        <details className="diagnostics">
          <summary>Diagnostics</summary>
          <ActionDetailsGrid action={action} />
        </details>
        <Button variant="primary" size="sm" icon="arrow-right" onClick={onOpenProposals}>
          Open review
        </Button>
      </div>
    </div>
  );
}

/** One row in the staged-review summary. */
function ReviewSummaryRow({ label, value, emphasized = false }: { label: string; value: string; emphasized?: boolean }): React.ReactElement {
  return (
    <div className="review-summary__row">
      <span>{label}</span>
      <strong className={emphasized ? "review-summary__value--emphasized" : undefined}>{value}</strong>
    </div>
  );
}

/** Plain-language evidence summary for review proposals. */
function ReviewEvidenceSummary({ details }: { details: Record<string, unknown> }): React.ReactElement | null {
  const familyReuseCount = readNumberDetail(details.support_family_reuse_count);
  const groundedFamilyReuseCount = readNumberDetail(details.support_grounded_family_reuse_count);
  const supportEvidence = readStringArrayDetail(details.support_evidence);
  const hasSupportedCandidate = details.supported_candidate === true;

  const lines = [
    familyReuseCount > 0
      ? `${familyReuseCount} related memor${familyReuseCount === 1 ? "y already uses" : "ies already use"} a compatible key.`
      : null,
    groundedFamilyReuseCount > 0
      ? `${groundedFamilyReuseCount} of those related memories include supporting provenance.`
      : null,
    hasSupportedCandidate || supportEvidence.length > 0 ? "Dreaming found matching evidence in the existing corpus." : null,
  ].filter((line): line is string => line !== null);

  if (lines.length === 0) {
    return null;
  }

  return (
    <div className="review-evidence">
      <span className="section-title">Why it was suggested</span>
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </div>
  );
}

/** Renders the concrete change payload for one dream action. */
function DreamActionChangeSummary({ action }: { action: DreamRunActionView }): React.ReactElement {
  const durableById = new Map(action.durables.map((durable) => [durable.id, durable]));

  return (
    <div className="stack" style={{ gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
      {action.durableIds.length > 0 ? (
        <div className="row wrap" style={{ gap: "var(--space-2)" }}>
          <span className="muted" style={{ fontSize: "var(--text-xs)" }}>Affected</span>
          {action.durableIds.map((durableId) => {
            const label = formatAffectedDurableReference(durableId, action.details, durableById);
            return (
              <Chip key={durableId} className="chip--compact" title={formatAffectedDurableReferenceTitle(durableId, action.details, durableById)}>
                <span className="truncate">{label}</span>
              </Chip>
            );
          })}
        </div>
      ) : null}

      {action.durables.length > 0 ? <ActionDurableList action={action} /> : null}

      {hasActionDetails(action) ? (
        <details className="diagnostics">
          <summary>Diagnostics</summary>
          <ActionDetailsGrid action={action} />
        </details>
      ) : null}
    </div>
  );
}

/** Renders action detail fields as an audit grid. */
function ActionDetailsGrid({ action }: { action: DreamRunActionView }): React.ReactElement | null {
  const details = action.details ? Object.entries(action.details).filter(([, value]) => value !== null && value !== undefined && value !== "") : [];
  const durableById = new Map(action.durables.map((durable) => [durable.id, durable]));

  if (details.length === 0) {
    return null;
  }

  return (
    <div className="change-grid">
      {details.map(([key, value]) => {
        const formatted = formatDetailValue(value, key, durableById);
        return (
          <div key={key} style={{ display: "contents" }}>
            <span className="change-grid__key">{formatDetailKey(key)}</span>
            <span className="change-grid__value truncate" title={formatted.title}>
              {formatted.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Returns whether an action has raw detail fields worth exposing in diagnostics. */
function hasActionDetails(action: DreamRunActionView): boolean {
  return action.details ? Object.values(action.details).some((value) => value !== null && value !== undefined && value !== "") : false;
}

/** Renders affected durable snippets for an action. */
function ActionDurableList({ action }: { action: DreamRunActionView }): React.ReactElement {
  return (
    <div className="stack" style={{ gap: "var(--space-2)" }}>
      {action.durables.map((durable) => (
        <div key={durable.id} className="change-item">
          <div className="spread" style={{ gap: "var(--space-2)" }}>
            <strong className="truncate" style={{ fontSize: "var(--text-xs)" }} title={durable.subject}>{durable.subject}</strong>
            {durable.claim_key ? (
              <span className="mono muted truncate" style={{ fontSize: "var(--text-2xs)" }} title={durable.claim_key}>
                {durable.claim_key}
              </span>
            ) : null}
          </div>
          <span className="muted truncate" style={{ fontSize: "var(--text-xs)" }} title={durable.content}>{durable.content}</span>
        </div>
      ))}
    </div>
  );
}

/** Formats a dreaming action type for operator display. */
function formatActionTypeLabel(actionType: string): string {
  return actionType === "flag_review" ? "Needs review" : titleCase(actionType);
}

/** Formats an action detail key for compact display. */
function formatDetailKey(key: string): string {
  return DETAIL_KEY_LABELS[key] ?? titleCase(key.replaceAll("_", " "));
}

/** Operator-facing detail value with the raw value preserved for hover text. */
interface FormattedDetailValue {
  label: string;
  title: string;
}

/** Formats a durable reference as a stable operator-facing label. */
function formatDurableReference(durableId: string, durableById: Map<string, DreamRunActionView["durables"][number]>): string {
  const durable = durableById.get(durableId);
  if (!durable) {
    return "Missing durable";
  }
  if (durable.claim_key) {
    return `${durable.subject} - ${durable.claim_key}`;
  }
  return durable.subject;
}

/** Formats an affected durable list item without exposing storage IDs. */
function formatAffectedDurableReference(
  durableId: string,
  details: Record<string, unknown> | null,
  durableById: Map<string, DreamRunActionView["durables"][number]>,
): string {
  const durable = durableById.get(durableId);
  if (durable) {
    return formatDurableReference(durableId, durableById);
  }
  return formatMissingDurableLabel(durableId, details);
}

/** Builds full hover text for an affected durable chip. */
function formatDurableReferenceTitle(durableId: string, durableById: Map<string, DreamRunActionView["durables"][number]>): string {
  const durable = durableById.get(durableId);
  if (!durable) {
    return `Missing durable: ${durableId}`;
  }
  const parts = [`${durable.subject}`, durable.claim_key ? `Claim key: ${durable.claim_key}` : null, `Durable ID: ${durable.id}`];
  return parts.filter((part): part is string => Boolean(part)).join("\n");
}

/** Builds hover text for an affected durable list item. */
function formatAffectedDurableReferenceTitle(
  durableId: string,
  details: Record<string, unknown> | null,
  durableById: Map<string, DreamRunActionView["durables"][number]>,
): string {
  const durable = durableById.get(durableId);
  if (durable) {
    return formatDurableReferenceTitle(durableId, durableById);
  }
  return `${formatMissingDurableLabel(durableId, details)}: ${durableId}`;
}

/** Replaces raw durable UUIDs in persisted action prose with friendly labels. */
function formatActionReasoning(
  reasoning: string,
  details: Record<string, unknown> | null,
  durableById: Map<string, DreamRunActionView["durables"][number]>,
): string {
  const predecessorId = typeof details?.predecessor_id === "string" ? details.predecessor_id : null;
  const successorId = typeof details?.successor_id === "string" ? details.successor_id : null;
  if (predecessorId && successorId && reasoning.startsWith("Superseded durable ")) {
    const predecessor = formatSentenceReference(formatAffectedDurableReference(predecessorId, details, durableById));
    const successor = formatSentenceReference(formatAffectedDurableReference(successorId, details, durableById));
    return `Superseded ${predecessor} with temporal revision ${successor}.`;
  }

  return reasoning.replace(UUID_IN_TEXT_PATTERN, (durableId) => formatAffectedDurableReference(durableId, details, durableById));
}

/** Makes role labels read naturally inside generated prose. */
function formatSentenceReference(label: string): string {
  if (label === "Previous durable" || label === "Replacement durable" || label === "Missing durable") {
    return `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  }
  return label;
}

/** Labels missing durable references by their role when action details expose it. */
function formatMissingDurableLabel(durableId: string, details: Record<string, unknown> | null): string {
  if (details?.predecessor_id === durableId) {
    return "Previous durable";
  }
  if (details?.successor_id === durableId) {
    return "Replacement durable";
  }
  return "Missing durable";
}

/** Formats a structured action detail value for compact display. */
function formatDetailValue(value: unknown, key: string, durableById: Map<string, DreamRunActionView["durables"][number]>): FormattedDetailValue {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => formatDetailValue(entry, key, durableById));
    return {
      label: summarizeDetailList(entries, key),
      title: entries.map((entry) => entry.title).join("\n"),
    };
  }

  if (typeof value === "object" && value !== null) {
    const raw = JSON.stringify(value);
    return { label: raw, title: raw };
  }

  const text = String(value);
  const durable = durableById.get(text);
  if (durable) {
    return { label: formatDurableReference(text, durableById), title: formatDurableReferenceTitle(text, durableById) };
  }
  if (isTimestampDetail(key, text)) {
    return { label: formatDateTime(text), title: text };
  }
  if (isEvidenceReference(text)) {
    return { label: "Episode evidence", title: text };
  }
  if (UUID_PATTERN.test(text)) {
    return { label: friendlyIdentifierLabel(key), title: text };
  }
  return { label: text, title: text };
}

/** Summarizes repeated action detail values without exposing raw storage IDs. */
function summarizeDetailList(entries: FormattedDetailValue[], key: string): string {
  if (entries.length === 0) {
    return "-";
  }
  if (key === "evidence_refs") {
    return entries.length === 1 ? entries[0]?.label ?? "Evidence" : `${entries.length} evidence refs`;
  }
  return entries.map((entry) => entry.label).join(", ");
}

/** Returns whether a detail value is an ISO timestamp field. */
function isTimestampDetail(key: string, value: string): boolean {
  if (!/(?:_at|_to|_from)$/u.test(key)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

/** Returns whether a raw evidence reference contains an internal storage UUID. */
function isEvidenceReference(value: string): boolean {
  const [prefix, id] = value.split(":", 2);
  return prefix === "episode" && id !== undefined && UUID_PATTERN.test(id);
}

/** Builds a generic friendly label for an internal identifier detail. */
function friendlyIdentifierLabel(key: string): string {
  const label = DETAIL_KEY_LABELS[key] ?? titleCase(key.replaceAll("_", " "));
  return label.toLowerCase().includes("durable") ? label : `${label} record`;
}

/** Reads a string array from an untyped action-detail payload. */
function readStringArrayDetail(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

/** Reads a number from an untyped action-detail payload. */
function readNumberDetail(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Formats claim-key arrays for compact review summaries. */
function formatClaimKeyList(values: string[], fallback: string): string {
  return values.length > 0 ? values.join(", ") : fallback;
}

/** Describes the review action available for a proposal. */
function formatReviewDecisionText(eligibleForApply: boolean, blocker: string | null): string {
  if (eligibleForApply) {
    return "Apply is available if the proposed key is correct.";
  }
  if (blocker) {
    return `Reject or inspect manually. ${formatAutoApplyBlocker(blocker)}.`;
  }
  return "Reject or inspect manually. Apply is not available for this proposal.";
}

/** Formats a stored automatic-apply blocker without internal enum wording. */
function formatAutoApplyBlocker(blocker: string): string {
  if (blocker === "cross_type_collision") {
    return "Another active memory already uses that key for a different type";
  }
  return `Automatic apply was blocked by ${titleCase(blocker.replaceAll("_", " ")).toLowerCase()}`;
}
