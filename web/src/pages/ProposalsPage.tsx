import { useState } from "react";

import { api } from "../api/client";
import { Button, Card, EmptyState } from "../components/primitives";
import { ErrorCard, RequireInstance, Skeleton } from "../components/states";
import { useAsync } from "../hooks/useAsync";
import { useInstances } from "../state/InstanceContext";
import { ProposalDrawer } from "./proposals/ProposalDrawer";
import { PROPOSAL_ISSUE_FILTERS } from "./proposals/proposal-review-ui";
import { ProposalRow } from "./proposals/ProposalRow";

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
  const [issueKind, setIssueKind] = useState("");
  const [minConfidence, setMinConfidence] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);

  const state = useAsync(
    () =>
      api.proposals({
        includeIneligible: !eligibleOnly,
        issueKind: issueKind || undefined,
        minConfidence: minConfidence > 0 ? minConfidence : undefined,
        limit: 200,
      }),
    [selected?.record.id, eligibleOnly, issueKind, minConfidence, reloadToken],
  );

  const reload = (): void => setReloadToken((value) => value + 1);

  return (
    <div className="stack" style={{ gap: "var(--space-6)" }}>
      <div className="page-head">
        <div className="page-head__lead">
          <h2>Proposal review</h2>
          <p>Review suggested claim-key changes from dreaming. Apply writes the proposed key after a backup; reject leaves the memory unchanged.</p>
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
          <span className="label">Issue kind</span>
          <select className="select" value={issueKind} onChange={(event) => setIssueKind(event.target.value)}>
            {PROPOSAL_ISSUE_FILTERS.map((option) => (
              <option key={option.value || "all"} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
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
