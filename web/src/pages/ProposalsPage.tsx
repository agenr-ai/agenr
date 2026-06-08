import { useState } from "react";

import { ApiError, api } from "../api/client";
import type { Durable, ProposalBacklogItem, ProposalDetail } from "../api/types";
import { Badge, Button, Card, CardBody, Drawer, EmptyState, Field, Input, Select, Textarea } from "../components/primitives";
import { ErrorCard, RequireInstance, Skeleton } from "../components/states";
import { useToast } from "../components/Toast";
import { useAsync } from "../hooks/useAsync";
import { useInstances } from "../state/InstanceContext";
import { formatIssueKind, formatPercent, formatRelative, titleCase, truncate } from "../lib/format";

const PROPOSAL_ISSUE_FILTERS = [
  { value: "", label: "All issue kinds" },
  { value: "claim_key_alias_convergence", label: "Claim-Key Alias Convergence" },
  { value: "entity_family_convergence", label: "Entity Family Convergence" },
  { value: "mixed_claim_key_group", label: "Mixed Claim-Key Group" },
  { value: "missing_claim_key", label: "Missing Claim Key" },
  { value: "suspect_canonical_claim_key", label: "Suspect Canonical Claim Key" },
  { value: "noncanonical_claim_key", label: "Noncanonical Claim Key" },
  { value: "malformed_claim_key", label: "Malformed Claim Key" },
];

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
              <Badge status="info">{formatIssueKind(proposal.issueKind)}</Badge>
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
              Open review
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
  const manualMixedResolution = proposal ? isManualMixedClaimProposal(proposal) : false;

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
            ) : isAliasConvergenceProposal(proposal) ? (
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
              {manualMixedResolution ? "Flagged keys" : isAliasConvergenceProposal(proposal) ? "Alias cluster" : "Proposed change"}
            </span>
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

type ManualResolutionChoice = "separate" | "canonical" | "retire";

/** Manual settlement workflow for mixed-key groups without a safe direct target. */
function ManualMixedClaimResolution({
  proposalId,
  durables,
  onReviewed,
}: {
  proposalId: string;
  durables: Durable[];
  onReviewed: () => void;
}): React.ReactElement {
  const toast = useToast();
  const uniqueClaimKeys = uniqueStrings(durables.flatMap((durable) => (durable.claim_key ? [durable.claim_key] : [])));
  const [choice, setChoice] = useState<ManualResolutionChoice>("separate");
  const [selectedClaimKey, setSelectedClaimKey] = useState(uniqueClaimKeys[0] ?? "__custom");
  const [customClaimKey, setCustomClaimKey] = useState("");
  const [selectedRetireIds, setSelectedRetireIds] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const settle = async (): Promise<void> => {
    const reason = buildManualResolutionReason(choice, note, resolveTargetClaimKey(choice, selectedClaimKey, customClaimKey), selectedRetireIds.length);
    setBusy(true);
    try {
      if (choice === "canonical") {
        const targetClaimKey = resolveTargetClaimKey(choice, selectedClaimKey, customClaimKey);
        if (!targetClaimKey) {
          toast.error("Claim key required", "Choose or enter a canonical claim key.");
          return;
        }
        for (const durable of durables) {
          if (durable.claim_key !== targetClaimKey) {
            await api.updateDurable(durable.id, { claimKey: targetClaimKey });
          }
        }
      } else if (choice === "retire") {
        if (selectedRetireIds.length === 0) {
          toast.error("Selection required", "Select at least one durable to retire.");
          return;
        }
        for (const durableId of selectedRetireIds) {
          await api.retireDurable(durableId, reason);
        }
      }

      await api.reviewProposal(proposalId, { decision: "reject", reason });
      toast.success("Issue settled");
      onReviewed();
    } catch (error) {
      toast.error("Resolution failed", error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleRetireId = (durableId: string): void => {
    setSelectedRetireIds((current) => (current.includes(durableId) ? current.filter((id) => id !== durableId) : [...current, durableId]));
  };

  const targetClaimKey = resolveTargetClaimKey(choice, selectedClaimKey, customClaimKey);

  return (
    <div className="manual-resolution">
      <span className="section-title">Settle flagged issue</span>
      <div className="manual-resolution__choices">
        <ResolutionOption
          active={choice === "separate"}
          title="Keep separate"
          body="Close the flag and leave the current claim keys unchanged."
          onSelect={() => setChoice("separate")}
        />
        <ResolutionOption
          active={choice === "canonical"}
          title="Use one key"
          body="Write one trusted manual claim key to every affected durable, then close the flag."
          onSelect={() => setChoice("canonical")}
        />
        <ResolutionOption
          active={choice === "retire"}
          title="Retire selected"
          body="Close duplicate or wrong durables, then close the flag."
          onSelect={() => setChoice("retire")}
        />
      </div>

      {choice === "canonical" ? (
        <div className="metadata-form__grid">
          <div className="metadata-form__field metadata-form__field--wide">
            <Field label="Canonical claim key">
              <Select value={selectedClaimKey} onChange={(event) => setSelectedClaimKey(event.target.value)}>
                {uniqueClaimKeys.map((claimKey) => (
                  <option key={claimKey} value={claimKey}>
                    {claimKey}
                  </option>
                ))}
                <option value="__custom">Custom key</option>
              </Select>
            </Field>
          </div>
          {selectedClaimKey === "__custom" ? (
            <div className="metadata-form__field metadata-form__field--wide">
              <Field label="Custom key" hint="Canonical entity/attribute format">
                <Input value={customClaimKey} placeholder="entity/attribute" onChange={(event) => setCustomClaimKey(event.target.value)} />
              </Field>
            </div>
          ) : null}
          {targetClaimKey ? <span className="hint metadata-form__field--wide">Every active affected durable will use {targetClaimKey}.</span> : null}
        </div>
      ) : null}

      {choice === "retire" ? (
        <div className="manual-resolution__retire-list">
          {durables.map((durable) => (
            <label key={durable.id} className="manual-resolution__retire-row">
              <input type="checkbox" checked={selectedRetireIds.includes(durable.id)} onChange={() => toggleRetireId(durable.id)} />
              <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                <strong>{durable.subject}</strong>
                <span className="mono muted">{durable.claim_key ?? "(no key)"}</span>
              </span>
            </label>
          ))}
        </div>
      ) : null}

      <Field label="Decision note" hint="Saved on the proposal review record.">
        <Textarea rows={3} value={note} placeholder="Why does this settle the flagged issue?" onChange={(event) => setNote(event.target.value)} />
      </Field>

      <div className="row wrap" style={{ gap: "var(--space-3)", justifyContent: "flex-end" }}>
        <Button variant="primary" icon="check" loading={busy} onClick={() => void settle()}>
          Settle issue
        </Button>
      </div>
    </div>
  );
}

function ResolutionOption({
  active,
  title,
  body,
  onSelect,
}: {
  active: boolean;
  title: string;
  body: string;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <button className={`manual-resolution__option${active ? " is-active" : ""}`} onClick={onSelect}>
      <strong>{title}</strong>
      <span>{body}</span>
    </button>
  );
}

function isManualMixedClaimProposal(proposal: ProposalDetail["proposal"]): boolean {
  return proposal.issueKind === "mixed_claim_key_group" && !proposal.eligibleForApply && proposal.proposedClaimKeys.length === 0;
}

function isAliasConvergenceProposal(proposal: ProposalDetail["proposal"]): boolean {
  return proposal.issueKind === "claim_key_alias_convergence";
}

function formatIneligibleProposalHint(proposal: ProposalDetail["proposal"]): string {
  if (isAliasConvergenceProposal(proposal)) {
    return "Apply is blocked because this alias cluster is ambiguous, conflicting, or not LLM-confirmed.";
  }
  return "This proposal is not eligible to apply and can only be rejected.";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function resolveTargetClaimKey(choice: ManualResolutionChoice, selectedClaimKey: string, customClaimKey: string): string {
  if (choice !== "canonical") {
    return "";
  }
  return selectedClaimKey === "__custom" ? customClaimKey.trim() : selectedClaimKey.trim();
}

function buildManualResolutionReason(choice: ManualResolutionChoice, note: string, targetClaimKey: string, retireCount: number): string {
  const suffix = note.trim().length > 0 ? ` Note: ${note.trim()}` : "";
  if (choice === "canonical") {
    return `Resolved mixed claim-key group manually by writing canonical key "${targetClaimKey}".${suffix}`;
  }
  if (choice === "retire") {
    return `Resolved mixed claim-key group manually by retiring ${retireCount} duplicate or wrong durable${retireCount === 1 ? "" : "s"}.${suffix}`;
  }
  return `Resolved mixed claim-key group manually by keeping the affected durables under separate claim keys.${suffix}`;
}
