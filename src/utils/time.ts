const DURATION_PATTERN = /^(\d+)\s*([hdmy])$/i;

const UNIT_TO_MILLISECONDS: Record<string, number> = {
  h: 1000 * 60 * 60,
  d: 1000 * 60 * 60 * 24,
  m: 1000 * 60 * 60 * 24 * 30,
  y: 1000 * 60 * 60 * 24 * 365,
};

export function parseSince(since: string | undefined, now: Date = new Date()): Date | undefined {
  if (!since) {
    return undefined;
  }

  const trimmed = since.trim();
  if (!trimmed) {
    return undefined;
  }

  const durationMatch = trimmed.match(DURATION_PATTERN);
  if (durationMatch) {
    const amount = Number(durationMatch[1]);
    const unit = durationMatch[2]?.toLowerCase();
    const multiplier = unit ? UNIT_TO_MILLISECONDS[unit] : undefined;

    if (!Number.isFinite(amount) || amount <= 0 || !multiplier) {
      throw new Error("Invalid since value");
    }

    return new Date(now.getTime() - amount * multiplier);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid since value");
  }

  return parsed;
}
