import { useState } from "react";

import { ApiError, api } from "../../api/client";
import type { ProposalDetail } from "../../api/types";
import { isClaimKeyAliasConvergenceProposal, isManualMixedClaimKeyProposal } from "../../api/types";
import { ProposalStagingAuditPanel } from "../../components/dreaming/ActionReviewPanels";
import { Badge, Button, Card, CardBody, Drawer, EmptyState, Field, Textarea } from "../../components/primitives";
import { ErrorCard, Skeleton } from "../../components/states";
import { useToast } from "../../components/Toast";
import { useAsync } from "../../hooks/useAsync";
import { formatIssueKind, formatPercent, formatRelative, titleCase, truncate } from "../../lib/format";
import { ClaimDiff } from "./ClaimDiff";
import { ManualMixedClaimResolution } from "./ManualMixedClaimResolution";
import { formatIneligibleProposalHint } from "./proposal-review-ui";

/** Detail drawer with the proposal, affected durables, and review actions. */
export function ProposalDrawer({ proposalId, onClose, onReviewed }: { proposalId: string; onClose: () => void; onReviewed: () => void }): React.ReactElement {
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
  const manualMixedResolution = proposal ? isManualMixedClaimKeyProposal(proposal) : false;

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
            <Badge status="info">{formatIssueKind(proposal.issueKind)}</Badge>
            <Badge status="dream">{titleCase(proposal.scope)}</Badge>
            <Badge status="accent">{formatPercent(proposal.confidence)} confidence</Badge>
          </div>

          <div className="review-brief">
            <span className="section-title">Review decision</span>
            {manualMixedResolution ? (
              <>
                <p>This group has conflicting current claim keys and no safe proposed target. Settle the flagged issue with one explicit operator decision.</p>
                <ul className="review-checklist">
                  <li>Keep the current keys when the memories are separate slots.</li>
                  <li>Use one canonical key when the memories belong to the same slot.</li>
                  <li>Retire selected memories when they are duplicate or wrong.</li>
                </ul>
              </>
            ) : isClaimKeyAliasConvergenceProposal(proposal) ? (
              <>
                <p>
                  Decide whether these current claim keys describe one durable slot. Apply writes the proposed key after creating a backup. Reject keeps
                  the keys as they are and records why this alias should not be used.
                </p>
                <ul className="review-checklist">
                  <li>The affected durables should describe the same stable slot, not adjacent topics.</li>
                  <li>The proposed key should be the best canonical slot for the whole cluster.</li>
                  <li>Ineligible clusters need manual review because they are ambiguous, conflicting, or not LLM-confirmed.</li>
                </ul>
              </>
            ) : (
              <>
                <p>
                  Decide whether the affected memory should be grouped under the proposed claim key. Apply writes the proposed key after creating a
                  backup. Reject keeps the memory as it is and records why this suggestion should not be used.
                </p>
                <ul className="review-checklist">
                  <li>The memory text should be about the proposed topic.</li>
                  <li>The proposed key should describe the stable slot for this memory, not incidental wording.</li>
                  <li>The key should group this memory with the right related memories.</li>
                </ul>
              </>
            )}
          </div>

          <div className="stack" style={{ gap: "var(--space-2)" }}>
            <span className="section-title">
              {manualMixedResolution ? "Flagged keys" : isClaimKeyAliasConvergenceProposal(proposal) ? "Alias cluster" : "Proposed change"}
            </span>
            <ClaimDiff current={proposal.currentClaimKeys} proposed={proposal.proposedClaimKeys} />
          </div>

          <div className="stack" style={{ gap: "var(--space-2)" }}>
            <span className="section-title">Rationale</span>
            <p className="secondary" style={{ fontSize: "var(--text-sm)" }}>{proposal.rationale}</p>
          </div>

          <ProposalStagingAuditPanel details={state.data.stagingDetails} />

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

          {proposal.reviewStatus === "open" && manualMixedResolution ? (
            <ManualMixedClaimResolution proposalId={proposal.id} durables={state.data.activeDurables} onReviewed={onReviewed} />
          ) : proposal.reviewStatus === "open" ? (
            <div className="stack" style={{ gap: "var(--space-3)" }}>
              <Field label="Decision reason" hint="Explain why the proposed key should or should not be written.">
                <Textarea rows={3} value={reason} placeholder="Why is this the right decision for this memory?" onChange={(event) => setReason(event.target.value)} />
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
                <span className="hint" style={{ textAlign: "right" }}>{formatIneligibleProposalHint(proposal)}</span>
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
