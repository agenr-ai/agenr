/** Formatting helpers shared across the console. */

/**
 * Formats an ISO timestamp as a compact relative age (e.g. "3h ago").
 *
 * @param iso - ISO timestamp string, or null.
 * @returns Relative age, or an em-dash placeholder.
 */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) {
    return "-";
  }
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return "-";
  }

  const diffMs = Date.now() - then;
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  let text: string;
  if (abs < minute) {
    text = "just now";
    return text;
  } else if (abs < hour) {
    text = `${Math.round(abs / minute)}m`;
  } else if (abs < day) {
    text = `${Math.round(abs / hour)}h`;
  } else if (abs < 30 * day) {
    text = `${Math.round(abs / day)}d`;
  } else {
    text = `${Math.round(abs / (30 * day))}mo`;
  }

  return future ? `in ${text}` : `${text} ago`;
}

/**
 * Formats an ISO timestamp as a readable local date-time.
 *
 * @param iso - ISO timestamp string, or null.
 * @returns Localized date-time, or an em-dash placeholder.
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return "-";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Formats an ISO timestamp as a readable local date-time including seconds.
 *
 * @param iso - ISO timestamp string, or null.
 * @returns Localized date-time with seconds, or an em-dash placeholder.
 */
export function formatDateTimeSeconds(iso: string | null | undefined): string {
  if (!iso) {
    return "-";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Formats an ISO timestamp as local date-time with compact relative context.
 *
 * @param iso - ISO timestamp string, or null.
 * @returns Localized date-time plus relative age when available.
 */
export function formatDateTimeWithRelative(iso: string | null | undefined): string {
  const dateTime = formatDateTime(iso);
  const relative = formatRelative(iso);
  if (dateTime === "-" || relative === "-") {
    return dateTime;
  }
  return `${dateTime} (${relative})`;
}

/**
 * Formats a number with grouped thousands.
 *
 * @param value - Numeric value.
 * @returns Locale-grouped number string.
 */
export function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/**
 * Formats a USD cost with adaptive precision.
 *
 * @param value - Cost in USD.
 * @returns Currency-formatted string.
 */
export function formatCost(value: number): string {
  if (value === 0) {
    return "$0";
  }
  const fractionDigits = value < 1 ? 4 : 2;
  return `$${value.toFixed(fractionDigits)}`;
}

/**
 * Formats a 0-1 ratio as a whole percentage.
 *
 * @param value - Ratio between 0 and 1.
 * @returns Percentage string.
 */
export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Converts a snake or kebab token to Title Case.
 *
 * @param value - Raw token.
 * @returns Title-cased label.
 */
export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Formats dreaming proposal issue kinds for operator-facing views.
 *
 * @param value - Raw issue kind.
 * @returns Readable issue label.
 */
export function formatIssueKind(value: string): string {
  if (value === "claim_key_alias_convergence") {
    return "Claim-Key Alias Convergence";
  }
  return titleCase(value);
}

/**
 * Truncates text to a maximum length with an ellipsis.
 *
 * @param value - Source text.
 * @param max - Maximum length.
 * @returns Truncated text.
 */
export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}\u2026` : value;
}
