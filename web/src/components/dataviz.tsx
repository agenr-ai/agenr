import type { ReactNode } from "react";

/** Resolves a 0-100 score to a semantic color. */
function scoreColor(score: number): string {
  if (score >= 75) {
    return "var(--success)";
  }
  if (score >= 45) {
    return "var(--warning)";
  }
  return "var(--danger)";
}

/** Props accepted by the Gauge component. */
interface GaugeProps {
  /** Value from 0 to 100. */
  value: number;
  /** Pixel diameter. Defaults to 132. */
  size?: number;
  /** Center label below the value. */
  label?: ReactNode;
}

/**
 * Radial gauge that renders a 0-100 score as a 270-degree arc.
 *
 * Used for the corpus health score so an operator reads overall state at a
 * glance, with the arc color shifting across danger, warning, and healthy
 * thresholds.
 *
 * @param props - Value, size, and center label.
 * @returns The rendered gauge.
 */
export function Gauge({ value, size = 132, label }: GaugeProps): React.ReactElement {
  const clamped = Math.max(0, Math.min(100, value));
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const arcFraction = 0.75;
  const arcLength = circumference * arcFraction;
  const filled = (clamped / 100) * arcLength;
  const color = scoreColor(clamped);

  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(135deg)" }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--bg-sunken)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${arcLength} ${circumference}`}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
          style={{ transition: "stroke-dasharray var(--dur-slow) var(--ease-out)", filter: `drop-shadow(0 0 6px ${color})` }}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
        }}
      >
        <span style={{ fontSize: "var(--text-2xl)", fontWeight: "var(--weight-bold)", color, lineHeight: 1 }} className="numeric">
          {Math.round(clamped)}
        </span>
        {label ? <span style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span> : null}
      </div>
    </div>
  );
}

/** Props accepted by the Sparkline component. */
interface SparklineProps {
  /** Ordered data points. */
  data: number[];
  /** Pixel width. Defaults to 96. */
  width?: number;
  /** Pixel height. Defaults to 30. */
  height?: number;
  /** Stroke color. Defaults to the brand accent. */
  color?: string;
}

/**
 * Compact trend line with a soft area fill.
 *
 * @param props - Data points, dimensions, and color.
 * @returns The rendered sparkline, or an empty fragment when too few points.
 */
export function Sparkline({ data, width = 96, height = 30, color = "var(--accent)" }: SparklineProps): React.ReactElement {
  if (data.length < 2) {
    return <svg width={width} height={height} />;
  }

  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min || 1;
  const stepX = width / (data.length - 1);
  const points = data.map((value, index) => {
    const x = index * stepX;
    const y = height - ((value - min) / span) * (height - 4) - 2;
    return [x, y] as const;
  });

  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width} ${height} L0 ${height} Z`;
  const gradientId = `spark-${Math.round(min)}-${Math.round(max)}-${data.length}`;

  return (
    <svg width={width} height={height}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** One labeled bar for the MiniBars chart. */
export interface MiniBar {
  label: string;
  value: number;
  color?: string;
}

/**
 * Horizontal labeled bar chart for small distributions.
 *
 * @param props - Bars to render.
 * @returns The rendered bar list.
 */
export function MiniBars({ bars }: { bars: MiniBar[] }): React.ReactElement {
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  return (
    <div className="stack" style={{ gap: "var(--space-3)" }}>
      {bars.map((bar) => (
        <div key={bar.label} className="stack" style={{ gap: 5 }}>
          <div className="spread" style={{ fontSize: "var(--text-xs)" }}>
            <span className="secondary">{bar.label}</span>
            <span className="numeric muted">{bar.value.toLocaleString()}</span>
          </div>
          <div className="meter">
            <div className="meter__fill" style={{ width: `${(bar.value / max) * 100}%`, background: bar.color ?? "var(--accent)" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** One segment of a stacked proportion bar. */
export interface StackSegment {
  label: string;
  value: number;
  color: string;
}

/**
 * Single-row stacked proportion bar with a legend.
 *
 * Useful for one-glance composition views such as claim-key lifecycle mix.
 *
 * @param props - Segments to render.
 * @returns The rendered stacked bar and legend.
 */
export function StackedBar({ segments }: { segments: StackSegment[] }): React.ReactElement {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0) || 1;
  return (
    <div className="stack" style={{ gap: "var(--space-3)" }}>
      <div style={{ display: "flex", height: 10, borderRadius: "var(--radius-pill)", overflow: "hidden", background: "var(--bg-sunken)" }}>
        {segments.map((segment) =>
          segment.value > 0 ? (
            <div
              key={segment.label}
              title={`${segment.label}: ${segment.value}`}
              style={{ width: `${(segment.value / total) * 100}%`, background: segment.color, transition: "width var(--dur-slow) var(--ease-out)" }}
            />
          ) : null,
        )}
      </div>
      <div className="row wrap" style={{ gap: "var(--space-4)" }}>
        {segments.map((segment) => (
          <span key={segment.label} className="row" style={{ gap: 6, fontSize: "var(--text-xs)" }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: segment.color }} />
            <span className="secondary">{segment.label}</span>
            <span className="numeric muted">{segment.value.toLocaleString()}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Props accepted by the Delta indicator. */
interface DeltaProps {
  /** Signed change value. */
  value: number;
  /** Optional formatter for the magnitude. */
  format?: (value: number) => string;
}

/**
 * Directional delta indicator that colors by sign.
 *
 * @param props - Signed value and optional formatter.
 * @returns The rendered delta.
 */
export function Delta({ value, format }: DeltaProps): React.ReactElement {
  const direction = value > 0 ? "up" : value < 0 ? "down" : "flat";
  const arrow = direction === "up" ? "\u2191" : direction === "down" ? "\u2193" : "\u2192";
  const text = format ? format(Math.abs(value)) : String(Math.abs(value));
  return (
    <span className={`delta delta--${direction}`}>
      {arrow} {text}
    </span>
  );
}
