const STABLE_VERSION_REGEX = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)$/u;
const ALPHA_VERSION_REGEX = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)-alpha\.(?<alpha>[1-9]\d*)$/u;
const BETA_VERSION_REGEX = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)-beta\.(?<beta>[1-9]\d*)$/u;
const CORRECTION_VERSION_REGEX = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<patch>[1-9]\d*)-(?<correction>[1-9]\d*)$/u;

/**
 * Parsed agenr release version metadata.
 */
export type ParsedReleaseVersion = {
  version: string;
  baseVersion: string;
  channel: "stable" | "alpha" | "beta";
  year: number;
  month: number;
  patch: number;
  alphaNumber?: number;
  betaNumber?: number;
  correctionNumber?: number;
};

/** Parses one release-version regex match into normalized release metadata. */
function parseVersionParts(version: string, groups: Record<string, string | undefined>, channel: ParsedReleaseVersion["channel"]): ParsedReleaseVersion | null {
  const year = Number.parseInt(groups.year ?? "", 10);
  const month = Number.parseInt(groups.month ?? "", 10);
  const patch = Number.parseInt(groups.patch ?? "", 10);
  const alphaNumber = channel === "alpha" ? Number.parseInt(groups.alpha ?? "", 10) : undefined;
  const betaNumber = channel === "beta" ? Number.parseInt(groups.beta ?? "", 10) : undefined;

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(patch) || month < 1 || month > 12 || patch < 1) {
    return null;
  }
  if (channel === "beta" && (!Number.isInteger(betaNumber) || (betaNumber ?? 0) < 1)) {
    return null;
  }
  if (channel === "alpha" && (!Number.isInteger(alphaNumber) || (alphaNumber ?? 0) < 1)) {
    return null;
  }

  return {
    version,
    baseVersion: `${year}.${month}.${patch}`,
    channel,
    year,
    month,
    patch,
    alphaNumber,
    betaNumber,
  };
}

/**
 * Parses an agenr release version in OpenClaw's `YYYY.M.PATCH` calendar format.
 *
 * Supported shapes:
 * - stable: `YYYY.M.PATCH`
 * - correction: `YYYY.M.PATCH-N`
 * - alpha: `YYYY.M.PATCH-alpha.N`
 * - beta: `YYYY.M.PATCH-beta.N`
 */
export function parseReleaseVersion(version: string): ParsedReleaseVersion | null {
  const trimmed = version.trim();
  if (!trimmed) {
    return null;
  }

  const stableMatch = STABLE_VERSION_REGEX.exec(trimmed);
  if (stableMatch?.groups) {
    return parseVersionParts(trimmed, stableMatch.groups, "stable");
  }

  const alphaMatch = ALPHA_VERSION_REGEX.exec(trimmed);
  if (alphaMatch?.groups) {
    return parseVersionParts(trimmed, alphaMatch.groups, "alpha");
  }

  const betaMatch = BETA_VERSION_REGEX.exec(trimmed);
  if (betaMatch?.groups) {
    return parseVersionParts(trimmed, betaMatch.groups, "beta");
  }

  const correctionMatch = CORRECTION_VERSION_REGEX.exec(trimmed);
  if (correctionMatch?.groups) {
    const parsedCorrection = parseVersionParts(trimmed, correctionMatch.groups, "stable");
    const correctionNumber = Number.parseInt(correctionMatch.groups.correction ?? "", 10);
    if (parsedCorrection === null || !Number.isInteger(correctionNumber) || correctionNumber < 1) {
      return null;
    }

    return {
      ...parsedCorrection,
      correctionNumber,
    };
  }

  return null;
}

/** Returns true when `version` matches the agenr release version format. */
export function isReleaseVersion(version: string): boolean {
  return parseReleaseVersion(version) !== null;
}
