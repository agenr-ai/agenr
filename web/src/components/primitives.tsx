import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

import { Icon, type IconName } from "./Icon";

/** Semantic status used across badges, dots, and toasts. */
export type Status = "neutral" | "success" | "warning" | "danger" | "info" | "accent" | "dream";

/** Button visual variants. */
type ButtonVariant = "primary" | "ghost" | "subtle" | "danger" | "dream";

/** Props accepted by the Button component. */
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  icon?: IconName;
  loading?: boolean;
}

/**
 * Primary action button with variants, optional icon, and loading state.
 *
 * @param props - Button props including variant, icon, and loading flag.
 * @returns The rendered button.
 */
export function Button({ variant = "subtle", size = "md", icon, loading, children, className, disabled, ...rest }: ButtonProps): React.ReactElement {
  const classes = ["btn", `btn--${variant}`, size === "sm" ? "btn--sm" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <button className={classes} disabled={disabled || loading} {...rest}>
      {loading ? <span className="spinner btn__spinner" /> : icon ? <Icon name={icon} size={size === "sm" ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

/** Props accepted by the Badge component. */
interface BadgeProps {
  status?: Status;
  children: ReactNode;
}

/**
 * Compact uppercase status label.
 *
 * @param props - Badge status and content.
 * @returns The rendered badge.
 */
export function Badge({ status = "neutral", children }: BadgeProps): React.ReactElement {
  return <span className={`badge badge--${status}`}>{children}</span>;
}

/** Props accepted by the StatusDot component. */
interface StatusDotProps {
  status?: Status;
  pulse?: boolean;
}

/**
 * Small colored status indicator with optional pulse animation.
 *
 * @param props - Dot status and pulse flag.
 * @returns The rendered dot.
 */
export function StatusDot({ status = "neutral", pulse }: StatusDotProps): React.ReactElement {
  return <span className={`dot dot--${status}${pulse ? " dot--pulse" : ""}`} />;
}

/** Inline loading spinner. */
export function Spinner(): React.ReactElement {
  return <span className="spinner" />;
}

/** Props accepted by Card. */
interface CardProps {
  children: ReactNode;
  raised?: boolean;
  className?: string;
}

/**
 * Surface container with subtle elevation.
 *
 * @param props - Card content and styling flags.
 * @returns The rendered card.
 */
export function Card({ children, raised, className }: CardProps): React.ReactElement {
  return <div className={`card${raised ? " card--raised" : ""}${className ? ` ${className}` : ""}`}>{children}</div>;
}

/** Props accepted by CardHeader. */
interface CardHeaderProps {
  title: ReactNode;
  icon?: IconName;
  actions?: ReactNode;
}

/**
 * Header row for a card with a title and optional actions.
 *
 * @param props - Title, optional icon, and action content.
 * @returns The rendered header.
 */
export function CardHeader({ title, icon, actions }: CardHeaderProps): React.ReactElement {
  return (
    <div className="card__header">
      <span className="card__title">
        {icon ? <Icon name={icon} size={15} /> : null}
        {title}
      </span>
      {actions}
    </div>
  );
}

/** Props accepted by CardBody. */
interface CardBodyProps {
  children: ReactNode;
  flush?: boolean;
}

/**
 * Padded body region for a card.
 *
 * @param props - Body content and a flush (no padding) flag.
 * @returns The rendered body.
 */
export function CardBody({ children, flush }: CardBodyProps): React.ReactElement {
  return <div className={`card__body${flush ? " card__body--flush" : ""}`}>{children}</div>;
}

/** Props accepted by EmptyState. */
interface EmptyStateProps {
  icon?: IconName;
  title: string;
  message?: ReactNode;
  action?: ReactNode;
}

/**
 * Centered placeholder for empty or unselected views.
 *
 * @param props - Icon, title, message, and optional action.
 * @returns The rendered empty state.
 */
export function EmptyState({ icon = "search", title, message, action }: EmptyStateProps): React.ReactElement {
  return (
    <div className="empty">
      <span className="empty__icon">
        <Icon name={icon} size={22} />
      </span>
      <div className="stack" style={{ gap: "var(--space-1)", alignItems: "center" }}>
        <strong style={{ color: "var(--text-secondary)" }}>{title}</strong>
        {message ? <span className="muted" style={{ fontSize: "var(--text-sm)" }}>{message}</span> : null}
      </div>
      {action}
    </div>
  );
}

/** A single key/value pair for the KeyValue grid. */
export interface KeyValueRow {
  key: ReactNode;
  value: ReactNode;
}

/**
 * Two-column key/value description grid.
 *
 * @param props - The rows to render.
 * @returns The rendered grid.
 */
export function KeyValue({ rows }: { rows: KeyValueRow[] }): React.ReactElement {
  return (
    <div className="kv">
      {rows.map((row, index) => (
        <div key={index} style={{ display: "contents" }}>
          <div className="kv__key">{row.key}</div>
          <div className="kv__val">{row.value}</div>
        </div>
      ))}
    </div>
  );
}

/** Props accepted by Chip. */
interface ChipProps {
  children: ReactNode;
  mono?: boolean;
  title?: string;
  className?: string;
}

/**
 * Rounded inline tag chip.
 *
 * @param props - Chip content and a monospace flag.
 * @returns The rendered chip.
 */
export function Chip({ children, mono, title, className }: ChipProps): React.ReactElement {
  const classes = ["chip", mono ? "chip--mono" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={classes} title={title}>
      {children}
    </span>
  );
}

/** One tab definition. */
export interface TabItem {
  id: string;
  label: ReactNode;
}

/**
 * Underlined tab strip.
 *
 * @param props - Tabs, active id, and change handler.
 * @returns The rendered tab strip.
 */
export function Tabs({ tabs, active, onChange }: { tabs: TabItem[]; active: string; onChange: (id: string) => void }): React.ReactElement {
  return (
    <div className="tabs">
      {tabs.map((tab) => (
        <button key={tab.id} className={`tab${tab.id === active ? " is-active" : ""}`} onClick={() => onChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** Props accepted by Field. */
interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}

/**
 * Labeled form field wrapper.
 *
 * @param props - Label, hint, and control content.
 * @returns The rendered field.
 */
export function Field({ label, hint, children }: FieldProps): React.ReactElement {
  return (
    <label className="field">
      {label ? <span className="label">{label}</span> : null}
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

/** Text input with console styling. */
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>): React.ReactElement {
  const { className, ...rest } = props;
  return <input className={`input${className ? ` ${className}` : ""}`} {...rest} />;
}

/** Select control with console styling. */
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>): React.ReactElement {
  const { className, children, ...rest } = props;
  return (
    <select className={`select${className ? ` ${className}` : ""}`} {...rest}>
      {children}
    </select>
  );
}

/** Multiline text input with console styling. */
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>): React.ReactElement {
  const { className, ...rest } = props;
  return <textarea className={`textarea${className ? ` ${className}` : ""}`} {...rest} />;
}

/** Props accepted by Drawer. */
interface DrawerProps {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}

/**
 * Right-anchored slide-over panel for detail and editor views.
 *
 * @param props - Title, subtitle, content, actions, and close handler.
 * @returns The rendered drawer.
 */
export function Drawer({ title, subtitle, onClose, children, actions }: DrawerProps): React.ReactElement {
  return (
    <>
      <div className="drawer__scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="drawer__header">
          <div className="grow">
            <div className="drawer__title">{title}</div>
            {subtitle ? <div className="drawer__sub">{subtitle}</div> : null}
          </div>
          <div className="row" style={{ gap: "var(--space-2)" }}>
            {actions}
            <Button variant="ghost" size="sm" icon="close" onClick={onClose} aria-label="Close" />
          </div>
        </div>
        <div className="drawer__body">{children}</div>
      </aside>
    </>
  );
}

/** Section heading with an optional icon. */
export function SectionTitle({ icon, children }: { icon?: IconName; children: ReactNode }): React.ReactElement {
  return (
    <div className="section-title">
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </div>
  );
}
