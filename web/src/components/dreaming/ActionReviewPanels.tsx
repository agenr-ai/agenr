/** Operator-facing React panels for dream run action review and diagnostics. */

import type { DreamRunActionView } from "../../api/types";
import { Button, Chip } from "../primitives.js";
import {
  buildAliasReviewSummary,
  formatAliasAutoApplyBlocker,
  formatClaimKeyList,
  type AliasReviewSummaryView,
} from "../../lib/alias-audit";
import { readStringArrayDetail } from "../../lib/action-details";
import {
  buildReviewEvidenceLines,
  formatActionReasoning,
  formatAffectedDurableReference,
  formatAffectedDurableReferenceTitle,
  formatDetailKey,
  formatDetailValue,
  formatActionTypeLabel,
  hasActionDetails,
} from "../../lib/dream-action-format";
import { formatPercent } from "../../lib/format";

export { formatActionTypeLabel, formatActionReasoning };

/** Plain-language summary for a proposal staged for human review. */
export function FlagReviewActionSummary({
  action,
  onOpenProposals,
}: {
  action: DreamRunActionView;
  onOpenProposals: () => void;
}): React.ReactElement {
  const details = action.details ?? {};
  const currentClaimKeys = readStringArrayDetail(details.current_claim_keys);
  const proposedClaimKeys = readStringArrayDetail(details.proposed_claim_keys);
  const confidence = typeof details.confidence === "number" ? details.confidence : null;
  const eligibleForApply = details.eligible_for_apply === true;
  const blocker = typeof details.auto_apply_blocker === "string" ? details.auto_apply_blocker : null;
  const durableById = new Map(action.durables.map((durable) => [durable.id, durable]));
  const aliasSummary = buildAliasReviewSummary(details);

  return (
    <div className="review-summary">
      <div className="review-summary__plain">
        <strong>
          {aliasSummary ? "Dreaming found a possible claim-key alias cluster." : "Dreaming found a suggested claim-key change."}
        </strong>
        <span>
          {aliasSummary
            ? "Review means deciding whether the current keys represent the same durable slot. Apply writes the proposed key after a backup; reject leaves the keys unchanged and records the reason."
            : "Review means deciding whether the affected memory belongs under the proposed key. Apply writes that key after a backup; reject leaves the memory unchanged and records the reason."}
        </span>
      </div>

      <div className="review-summary__grid">
        <ReviewSummaryRow label={aliasSummary ? "Current keys" : "Current key"} value={formatClaimKeyList(currentClaimKeys, "(no current key)")} />
        <ReviewSummaryRow label="Proposed key" value={formatClaimKeyList(proposedClaimKeys, "(no proposed key)")} emphasized />
        {confidence !== null ? <ReviewSummaryRow label="Confidence" value={formatPercent(confidence)} /> : null}
        <ReviewSummaryRow label="Decision" value={formatReviewDecisionText(eligibleForApply, blocker)} />
      </div>

      {aliasSummary ? <AliasReviewSummary summary={aliasSummary} /> : null}

      <div className="stack" style={{ gap: "var(--space-2)" }}>
        <span className="section-title">What to check</span>
        {aliasSummary ? (
          <ul className="review-checklist">
            <li>The current keys describe the same stable slot for the same entity.</li>
            <li>The proposed key is the best canonical target for all affected durables.</li>
            <li>Similar wording alone is not enough if the facts belong to different attributes.</li>
          </ul>
        ) : (
          <ul className="review-checklist">
            <li>The memory text is really about the proposed topic.</li>
            <li>The proposed key describes the stable slot this memory should be grouped under.</li>
            <li>Applying the key would group it with the right related memories, not just similar wording.</li>
          </ul>
        )}
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

      {hasActionDetails(action.details) ? (
        <details className="diagnostics review-summary__diagnostics">
          <summary>Diagnostics</summary>
          <ActionDetailsGrid action={action} />
        </details>
      ) : null}

      <div className="review-summary__actions">
        <Button variant="primary" size="sm" icon="arrow-right" onClick={onOpenProposals}>
          Open review
        </Button>
      </div>
    </div>
  );
}

/** Renders the concrete change payload for one dream action. */
export function DreamActionChangeSummary({ action }: { action: DreamRunActionView }): React.ReactElement {
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

      {hasActionDetails(action.details) ? (
        <details className="diagnostics">
          <summary>Diagnostics</summary>
          <ActionDetailsGrid action={action} />
        </details>
      ) : null}
    </div>
  );
}

/** Renders action detail fields as an audit grid. */
export function ActionDetailsGrid({ action }: { action: DreamRunActionView }): React.ReactElement | null {
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

/** Renders audit details from a proposal staging action without durable hydration. */
export function ProposalStagingAuditPanel({ details }: { details: Record<string, unknown> | null }): React.ReactElement | null {
  if (!details || !hasActionDetails(details)) {
    return null;
  }

  const aliasSummary = buildAliasReviewSummary(details);
  const durableById = new Map<string, DreamRunActionView["durables"][number]>();

  return (
    <div className="stack" style={{ gap: "var(--space-3)" }}>
      {aliasSummary ? <AliasReviewSummary summary={aliasSummary} /> : null}
      <ReviewEvidenceSummary details={details} />
      <details className="diagnostics">
        <summary>Diagnostics</summary>
        <div className="change-grid">
          {Object.entries(details)
            .filter(([, value]) => value !== null && value !== undefined && value !== "")
            .map(([key, value]) => {
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
      </details>
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

/** Renders the structured alias-convergence audit in a compact operator view. */
function AliasReviewSummary({ summary }: { summary: AliasReviewSummaryView }): React.ReactElement {
  return (
    <div className="review-evidence">
      <span className="section-title">Alias convergence audit</span>
      {summary.entityPrefix ? <span>Entity: {summary.entityPrefix}</span> : null}
      <span>Current keys: {formatClaimKeyList(summary.currentKeys, "(none)")}</span>
      {summary.proposedKey ? <span>Target key: {summary.proposedKey}</span> : null}
      {summary.deterministicConfidence !== null ? <span>Deterministic confidence: {formatPercent(summary.deterministicConfidence)}</span> : null}
      {summary.llmSameSlot !== null ? <span>LLM verdict: {summary.llmSameSlot ? "same slot" : "different slots"}</span> : null}
      {summary.llmConfidence !== null ? <span>LLM confidence: {formatPercent(summary.llmConfidence)}</span> : null}
      {summary.llmRationale ? <span>LLM rationale: {summary.llmRationale}</span> : null}
    </div>
  );
}

/** Plain-language evidence summary for review proposals. */
function ReviewEvidenceSummary({ details }: { details: Record<string, unknown> }): React.ReactElement | null {
  const lines = buildReviewEvidenceLines(details);
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

/** Describes the review action available for a proposal. */
function formatReviewDecisionText(eligibleForApply: boolean, blocker: string | null): string {
  if (eligibleForApply) {
    return "Apply is available if the proposed key is correct.";
  }
  if (blocker) {
    const formattedBlocker = formatAliasAutoApplyBlocker(blocker);
    return `Reject or inspect manually. ${formattedBlocker}${/[.!?]$/u.test(formattedBlocker) ? "" : "."}`;
  }
  return "Reject or inspect manually. Apply is not available for this proposal.";
}
