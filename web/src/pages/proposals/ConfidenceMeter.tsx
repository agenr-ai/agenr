import { formatPercent } from "../../lib/format";

/** Confidence percentage with a meter bar. */
export function ConfidenceMeter({ value }: { value: number }): React.ReactElement {
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
