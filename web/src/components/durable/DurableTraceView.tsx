import type { Durable, DurableTrace } from "../../api/types";
import { formatDateTime, formatDateTimeSeconds, formatRelative, titleCase } from "../../lib/format";
import { claimStatusVariant, durableState, durableStateVariant } from "../../lib/status";
import { Badge, Chip, KeyValue, Tabs } from "../primitives";
import { DurableRetireAction } from "./DurableRetireAction";

/** Read-only trace view with overview, lineage, and activity tabs. */
export function DurableTraceView({
  trace,
  tab,
  onTab,
  onMutated,
}: {
  trace: DurableTrace;
  tab: string;
  onTab: (id: string) => void;
  onMutated: () => void;
}): React.ReactElement {
  const { durable } = trace;
  const state = durableState(durable);

  return (
    <div className="stack" style={{ gap: "var(--space-5)" }}>
      <div className="row wrap" style={{ gap: "var(--space-2)" }}>
        <Badge status={durableStateVariant(state)}>{state}</Badge>
        <Badge status="neutral">{titleCase(durable.type)}</Badge>
        {durable.claim_key_status ? <Badge status={claimStatusVariant(durable.claim_key_status)}>{durable.claim_key_status}</Badge> : null}
        <Chip mono>importance {durable.importance.toFixed(2)}</Chip>
        <Chip mono>recalled {durable.recall_count}x</Chip>
      </div>

      <div>
        <h3 style={{ fontSize: "var(--text-lg)" }}>{durable.subject}</h3>
        <p className="secondary" style={{ marginTop: "var(--space-2)", fontSize: "var(--text-sm)", whiteSpace: "pre-wrap" }}>
          {durable.content}
        </p>
      </div>

      <Tabs tabs={[{ id: "overview", label: "Overview" }, { id: "lineage", label: "Lineage" }, { id: "activity", label: "Activity" }]} active={tab} onChange={onTab} />

      {tab === "overview" ? (
        <div className="stack" style={{ gap: "var(--space-4)" }}>
          <KeyValue
            rows={[
              { key: "Claim key", value: durable.claim_key ? <span className="mono">{durable.claim_key}</span> : "-" },
              { key: "Project", value: durable.project ?? "-" },
              { key: "Tags", value: durable.tags.length > 0 ? durable.tags.join(", ") : "-" },
              { key: "Source", value: trace.provenance.sourceFile ? <span className="mono">{trace.provenance.sourceFile}</span> : "-" },
              { key: "Claim source", value: trace.provenance.claimKeySource ?? "-" },
              { key: "Valid from", value: durable.valid_from ? formatDateTime(durable.valid_from) : "-" },
              { key: "Valid to", value: durable.valid_to ? formatDateTime(durable.valid_to) : "open" },
              { key: "Created", value: formatDateTime(durable.created_at) },
              { key: "Updated", value: formatDateTime(durable.updated_at) },
              { key: "Recalls", value: `${trace.recall.totalCount} total` },
            ]}
          />
          {state === "active" ? <DurableRetireAction id={durable.id} onRetired={onMutated} /> : null}
        </div>
      ) : null}

      {tab === "lineage" ? (
        <div className="stack" style={{ gap: "var(--space-4)" }}>
          {trace.supersededBy ? (
            <div className="stack" style={{ gap: "var(--space-2)" }}>
              <span className="section-title">Superseded by</span>
              <LineageRow durable={trace.supersededBy} />
            </div>
          ) : null}
          {trace.supersedes.length > 0 ? (
            <div className="stack" style={{ gap: "var(--space-2)" }}>
              <span className="section-title">Supersedes</span>
              {trace.supersedes.map((item) => (
                <LineageRow key={item.id} durable={item} />
              ))}
            </div>
          ) : null}
          {trace.claimFamily ? (
            <div className="stack" style={{ gap: "var(--space-2)" }}>
              <span className="section-title">
                Claim family · {trace.claimFamily.slotPolicy}
              </span>
              {trace.claimFamily.durables.map((item) => (
                <LineageRow key={item.id} durable={item} highlight={item.id === durable.id} />
              ))}
            </div>
          ) : null}
          {!trace.supersededBy && trace.supersedes.length === 0 && !trace.claimFamily ? (
            <span className="muted" style={{ fontSize: "var(--text-sm)" }}>No supersession lineage or claim family for this durable.</span>
          ) : null}
        </div>
      ) : null}

      {tab === "activity" ? (
        <div className="stack" style={{ gap: "var(--space-4)" }}>
          <div className="timeline">
            {trace.timeline.length === 0 ? (
              <span className="muted" style={{ fontSize: "var(--text-sm)" }}>No recorded activity.</span>
            ) : (
              trace.timeline.map((event, index) => (
                <div className="tl-item" key={index}>
                  <div className={`tl-node${event.kind === "created" || event.kind === "dream" ? " tl-node--accent" : ""}`} />
                  <div className="stack" style={{ gap: 2 }}>
                    <div className="spread">
                      <strong style={{ fontSize: "var(--text-sm)" }}>{event.label}</strong>
                      <span className="tl-time" title={event.at}>
                        <span className="tl-time__exact">{formatDateTimeSeconds(event.at)}</span>
                        <span className="tl-time__relative">{formatRelative(event.at)}</span>
                      </span>
                    </div>
                    {event.detail ? <span className="muted" style={{ fontSize: "var(--text-xs)" }}>{event.detail}</span> : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Compact lineage row for a related durable. */
function LineageRow({ durable, highlight }: { durable: Durable; highlight?: boolean }): React.ReactElement {
  return (
    <div className="card" style={{ padding: "var(--space-3)", borderColor: highlight ? "var(--accent-dim)" : undefined }}>
      <div className="spread">
        <span className="mono muted" style={{ fontSize: "var(--text-2xs)" }}>{durable.id}</span>
        <span className="muted" style={{ fontSize: "var(--text-xs)" }}>{formatRelative(durable.created_at)}</span>
      </div>
      <strong style={{ fontSize: "var(--text-sm)", display: "block", marginTop: 4 }}>{durable.subject}</strong>
    </div>
  );
}
