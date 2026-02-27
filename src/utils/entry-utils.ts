export const MILLISECONDS_PER_DAY = 1000 * 60 * 60 * 24;

export function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return Number.NaN;
}

export function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

export function toRowsAffected(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return Number(value);
  }
  return 0;
}

export function parseDaysBetween(now: Date, pastIso: string | undefined): number {
  if (!pastIso) {
    return 0;
  }

  const parsed = new Date(pastIso);
  if (Number.isNaN(parsed.getTime())) {
    return 0;
  }

  const delta = (now.getTime() - parsed.getTime()) / MILLISECONDS_PER_DAY;
  if (!Number.isFinite(delta)) {
    return 0;
  }

  return Math.max(delta, 0);
}
