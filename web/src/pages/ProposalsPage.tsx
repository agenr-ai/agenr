import { useState } from "react";

import { ApiError, api } from "../api/client";
import type { ProposalBacklogItem, ProposalDetail } from "../api/types";
import { Badge, Button, Card, CardBody, Drawer, EmptyState, Field, Textarea } from "../components/primitives";
import { ErrorCard, RequireInstance, Skeleton } from "../components/states";
import { useToast } from "../components/Toast";
import { useAsync } from "../hooks/useAsync";
import { useInstances } from "../state/InstanceContext";
import { formatPercent, formatRelative, titleCase, truncate } from "../lib/format";

/**
 * Proposal Review page: triage and adjudicate claim-key proposals.
 *
 * @returns The rendered proposals page.
 */
export function ProposalsPage(): React.ReactElement {
  return (
    <RequireInstance>
      <ProposalsInner />
    </RequireInstance>
  );
}

/** Proposals content shown once an instance is confirmed selected. */
function ProposalsInner(): React.ReactElement {
  const { selected } = useInstances();
  const [eligibleOnly, setEligibleOnly] = useState(true);
  const [minConfidence, setMinConfidence] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);

  const state = useAsync(
    () => api.proposals({ includeIneligible: !eligibleOnly, minConfidence: minConfidence > 0 ? minConfidence : undefined, limit: 200 }),
    [selected?.record.id, eligibleOnly, minConfidence, reloadToken],
  );

  const reload = (): void => setReloadToken((value) => value + 1);

  return (
    <div className="stack" style={{ gap: "var(--space-6)" }}>
      <div className="page-head">
        <div className="page-head__lead">
          <h2>Proposal review</h2>
          <p>Adjudicate claim-key proposals raised by dreaming. Applying mutates durables after a backup; both decisions require a reason.</p>
        </div>
        <Button variant="ghost" icon="refresh" onClick={state.refetch}>
          Refresh
        </Button>
      </div>

      <div className="filters">
        <div className="segmented">
          <button className={eligibleOnly ? "is-active" : ""} onClick={() => setEligibleOnly(true)}>
            Eligible only
          </button>
          <button className={!eligibleOnly ? "is-active" : ""} onClick={() => setEligibleOnly(false)}>
            All open
          </button>
        </div>
        <div className="row" style={{ gap: "var(--space-2)" }}>
          <span className="label">Min confidence</span>
          <select className="select" value={String(minConfidence)} onChange={(event) => setMinConfidence(Number(event.target.value))}>
            <option value="0">Any</option>
            <option value="0.5">50%+</option>
            <option value="0.7">70%+</option>
            <option value="0.9">90%+</option>
          </select>
        </div>
      </div>

      {state.loading && !state.data ? (
        <Skeleton height={200} />
      ) : state.error ? (
        <ErrorCard error={state.error} onRetry={state.refetch} />
      ) : (state.data?.backlog.length ?? 0) === 0 ? (
        <Card>
          <EmptyState icon="check" title="Inbox zero" message="No open proposals match these filters. The corpus is in good shape." />
        </Card>
      ) : (
        <div className="stack" style={{ gap: "var(--space-3)" }}>
          {state.data?.backlog.map((item) => <ProposalRow key={item.proposal.id} item={item} onOpen={() => setActiveId(item.proposal.id)} />)}
        </div>
      )}

      {activeId ? <ProposalDrawer proposalId={activeId} onClose={() => setActiveId(null)} onReviewed={() => { setActiveId(null); reload(); }} /> : null}
    </div>
  );
}

/** One proposal summary row in the backlog list. */
function ProposalRow({ item, onOpen }: { item: ProposalBacklogItem; onOpen: () => void }): React.ReactElement {
  const { proposal } = item;
  return (
    <Card>
      <CardBody>
        <div className="spread" style={{ gap: "var(--space-4)", alignItems: "flex-start" }}>
          <div className="grow stack" style={{ gap: "var(--space-3)", minWidth: 0 }}>
            <div className="row wrap" style={{ gap: "var(--space-2)" }}>
              <Badge status={proposal.eligibleForApply ? "success" : "neutral"}>{proposal.eligibleForApply ? "eligible" : "ineligible"}</Badge>
              <Badge status="info">{titleCase(proposal.issueKind)}</Badge>
              <Badge status="dream">{titleCase(proposal.scope)}</Badge>
              <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
                {proposal.durableIds.length} durable{proposal.durableIds.length === 1 ? "" : "s"} · {formatRelative(proposal.createdAt)}
              </span>
            </div>
            <ClaimDiff current={proposal.currentClaimKeys} proposed={proposal.proposedClaimKeys} />
            <p className="secondary" style={{ fontSize: "var(--text-sm)" }}>
              {truncate(proposal.rationale, 220)}
            </p>
          </div>
          <div className="stack" style={{ gap: "var(--space-3)", alignItems: "flex-end", flex: "none", width: 140 }}>
            <ConfidenceMeter value={proposal.confidence} />
            <Button variant="primary" size="sm" icon="arrow-right" onClick={onOpen}>
              Review
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

/** Confidence percentage with a meter bar. */
function ConfidenceMeter({ value }: { value: number }): React.ReactElement {
  const color = value >= 0.8 ? "var(--success)" : value >= 0.5 ? "var(--warning)" : "var(--danger)";
  return (
    <div className="stack" style={{ gap: 4, width: "100%" }}>
      <div className="spread" style={{ fontSize: "var(--text-xs)" }}>
        <span className="muted">confidence</span>
        <span className="numeric" style={{ color }}>
          {formatPercent(value)}
        </span>
      </div>
      <div className="meter">
        <div className="meter__fill" style={{ width: `${Math.round(value * 100)}%`, background: color }} />
      </div>
    </div>
  );
}

/** Claim-key before/after diff rendering. */
function ClaimDiff({ current, proposed }: { current: string[]; proposed: string[] }): React.ReactElement {
  return (
    <div className="diff">
      {current.length === 0 ? (
        <div className="diff__row diff__row--del">
          <span className="diff__mark">-</span>
          <span className="muted">(no current key)</span>
        </div>
      ) : (
        current.map((key) => (
          <div key={`c-${key}`} className="diff__row diff__row--del">
            <span className="diff__mark">-</span>
            <span>{key}</span>
          </div>
        ))
      )}
      {proposed.map((key) => (
        <div key={`p-${key}`} className="diff__row diff__row--add">
          <span className="diff__mark">+</span>
          <span>{key}</span>
        </div>
      ))}
    </div>
  );
}

/** Detail drawer with the proposal, affected durables, and review actions. */
function ProposalDrawer({ proposalId, onClose, onReviewed }: { proposalId: string; onClose: () => void; onReviewed: () => void }): React.ReactElement {
  const toast = useToast();
  const state = useAsync<ProposalDetail>(() => api.proposalDetail(proposalId), [proposalId]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"apply" | "reject" | null>(null);

  const review = async (decision: "apply" | "reject"): Promise<void> => {
    if (reason.trim().length === 0) {
      toast.error("Reason required", "Enter a short reason before deciding.");
      return;
    }
    setBusy(decision);
    try {
      await api.reviewProposal(proposalId, { decision, reason: reason.trim() });
      toast.success(decision === "apply" ? "Proposal applied" : "Proposal rejected");
      onReviewed();
    } catch (error) {
      toast.error("Review failed", error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const proposal = state.data?.proposal;

  return (
    <Drawer
      title="Review proposal"
      subtitle={proposal ? <span className="mono">{proposal.id}</span> : undefined}
      onClose={onClose}
    >
      {state.loading ? (
        <Skeleton height={300} />
      ) : state.error ? (
        <ErrorCard error={state.error} onRetry={state.refetch} />
      ) : state.data && proposal ? (
        <div className="stack" style={{ gap: "var(--space-5)" }}>
          <div className="row wrap" style={{ gap: "var(--space-2)" }}>
            <Badge status={proposal.eligibleForApply ? "success" : "neutral"}>{proposal.eligibleForApply ? "eligible" : "ineligible"}</Badge>
            <Badge status="info">{titleCase(proposal.issueKind)}</Badge>
            <Badge status="dream">{titleCase(proposal.scope)}</Badge>
            <Badge status="accent">{formatPercent(proposal.confidence)} confidence</Badge>
          </div>

          <div className="stack" style={{ gap: "var(--space-2)" }}>
            <span className="section-title">Proposed change</span>
            <ClaimDiff current={proposal.currentClaimKeys} proposed={proposal.proposedClaimKeys} />
          </div>

          <div className="stack" style={{ gap: "var(--space-2)" }}>
            <span className="section-title">Rationale</span>
            <p className="secondary" style={{ fontSize: "var(--text-sm)" }}>{proposal.rationale}</p>
          </div>

          <div className="stack" style={{ gap: "var(--space-2)" }}>
            <span className="section-title">Affected durables ({state.data.activeDurables.length})</span>
            {state.data.activeDurables.map((durable) => (
              <div key={durable.id} className="card" style={{ padding: "var(--space-3)" }}>
                <div className="spread">
                  <Badge status="neutral">{titleCase(durable.type)}</Badge>
                  {durable.claim_key ? <span className="mono muted" style={{ fontSize: "var(--text-2xs)" }}>{durable.claim_key}</span> : null}
                </div>
                <strong style={{ fontSize: "var(--text-sm)", display: "block", marginTop: "var(--space-2)" }}>{durable.subject}</strong>
                <p className="secondary" style={{ fontSize: "var(--text-xs)", marginTop: 4 }}>{truncate(durable.content, 240)}</p>
              </div>
            ))}
            {state.data.inactiveDurableIds.length > 0 ? (
              <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
                {state.data.inactiveDurableIds.length} referenced durable(s) are no longer active.
              </span>
            ) : null}
          </div>

          {proposal.reviewStatus === "open" ? (
            <div className="stack" style={{ gap: "var(--space-3)" }}>
              <Field label="Decision reason" hint="Recorded with the review for auditability.">
                <Textarea rows={3} value={reason} placeholder="Why apply or reject this proposal?" onChange={(event) => setReason(event.target.value)} />
              </Field>
              <div className="row" style={{ gap: "var(--space-3)", justifyContent: "flex-end" }}>
                <Button variant="danger" icon="x" loading={busy === "reject"} onClick={() => void review("reject")}>
                  Reject
                </Button>
                <Button variant="primary" icon="check" loading={busy === "apply"} disabled={!proposal.eligibleForApply} onClick={() => void review("apply")}>
                  Apply
                </Button>
              </div>
              {!proposal.eligibleForApply ? (
                <span className="hint" style={{ textAlign: "right" }}>This proposal is not eligible to apply and can only be rejected.</span>
              ) : null}
            </div>
          ) : (
            <Card>
              <CardBody>
                <div className="row" style={{ gap: "var(--space-2)" }}>
                  <Badge status={proposal.reviewStatus === "applied" ? "success" : "neutral"}>{titleCase(proposal.reviewStatus)}</Badge>
                  <span className="muted" style={{ fontSize: "var(--text-xs)" }}>{formatRelative(proposal.reviewedAt)}</span>
                </div>
                {proposal.reviewReason ? <p className="secondary" style={{ fontSize: "var(--text-sm)", marginTop: "var(--space-2)" }}>{proposal.reviewReason}</p> : null}
              </CardBody>
            </Card>
          )}
        </div>
      ) : (
        <EmptyState icon="alert" title="Proposal unavailable" />
      )}
    </Drawer>
  );
}
