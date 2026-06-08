import type { ReactNode } from "react";

import { Sparkline } from "./dataviz";
import { Icon, type IconName } from "./Icon";

/** Props accepted by StatTile. */
interface StatTileProps {
  /** Uppercase label. */
  label: string;
  /** Primary value. */
  value: ReactNode;
  /** Optional leading icon. */
  icon?: IconName;
  /** Accent color for the top rule and icon. */
  accent?: string;
  /** Optional footer content (delta, note). */
  foot?: ReactNode;
  /** Optional sparkline data shown in the corner. */
  spark?: number[];
}

/**
 * Compact metric tile with an accent rule and optional corner sparkline.
 *
 * @param props - Label, value, accent, footer, and sparkline data.
 * @returns The rendered stat tile.
 */
export function StatTile({ label, value, icon, accent = "var(--accent)", foot, spark }: StatTileProps): React.ReactElement {
  return (
    <div className="stat" style={{ ["--stat-accent" as string]: accent }}>
      <span className="stat__label">
        {icon ? <Icon name={icon} size={13} /> : null}
        {label}
      </span>
      <span className="stat__value">{value}</span>
      {foot ? <span className="stat__foot">{foot}</span> : null}
      {spark && spark.length > 1 ? (
        <span className="stat__spark">
          <Sparkline data={spark} color={accent} width={72} height={26} />
        </span>
      ) : null}
    </div>
  );
}
