/**
 * Parses an optional eval-case semantic clock.
 *
 * The returned date is passed through app/core dependencies instead of mutating
 * process-wide time, so overlapping internal eval HTTP requests stay isolated.
 *
 * @param nowIso - Optional ISO timestamp supplied by the eval sandbox request.
 * @returns Parsed semantic clock, or undefined when the case uses real time.
 */
export function parseEvalNow(nowIso: string | undefined): Date | undefined {
  if (!nowIso) {
    return undefined;
  }

  const parsed = new Date(nowIso);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`sandbox.now must be a parseable ISO timestamp. Received: ${nowIso}`);
  }

  return parsed;
}
