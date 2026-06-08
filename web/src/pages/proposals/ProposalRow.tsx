import type { ProposalBacklogItem } from "../../api/types";
import { Badge, Button, Card, CardBody } from "../../components/primitives";
import { formatIssueKind, formatRelative, titleCase, truncate } from "../../lib/format";
import { ClaimDiff } from "./ClaimDiff";
import { ConfidenceMeter } from "./ConfidenceMeter";

/** One proposal summary row in the backlog list. */
export function ProposalRow({ item, onOpen }: { item: ProposalBacklogItem; onOpen: () => void }): React.ReactElement {
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
