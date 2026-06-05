import { createHash, randomUUID } from "node:crypto";

import { parseDirectiveMetadata } from "../../core/directives/model.js";
import type { DreamProjectSummary } from "../../core/dreaming/types.js";
import { isWithinValidityWindow } from "../../core/temporal-validity.js";
import type { Durable } from "../../core/types.js";
import type { DreamPort, DreamProfileSnapshot } from "./ports.js";

const DEFAULT_MAX_PROFILE_DURABLES = 8;
const MIN_PROFILE_DURABLES = 1;
const MAX_PROFILE_DURABLES = 8;

/**
 * Options accepted by the profile projection stage.
 */
export interface DreamProjectStageOptions {
  runId: string;
  now(): Date;
  project?: string;
  maxProfileDurables?: number;
}

/**
 * Result returned by one profile projection stage run.
 */
export interface DreamProjectStageResult {
  summary: DreamProjectSummary;
  snapshot: DreamProfileSnapshot | null;
}

/**
 * Builds the profile snapshot candidate used at session start.
 *
 * @param options - Run identity, clock, scope, and profile-size controls.
 * @param deps - Dreaming persistence boundary.
 * @returns Projection summary plus the generated snapshot candidate when one exists.
 */
export async function runProjectStage(options: DreamProjectStageOptions, deps: { port: DreamPort }): Promise<DreamProjectStageResult> {
  const asOfDate = options.now();
  const asOf = asOfDate.toISOString();
  const maxProfileDurables = normalizeMaxProfileDurables(options.maxProfileDurables);
  const activeCurrent = (await deps.port.listReconcileDurables({ ...(options.project ? { project: options.project } : {}) })).filter((durable) =>
    isCurrentDurable(durable, asOfDate.getTime()),
  );
  const directiveDurables = activeCurrent.filter((durable) => parseDirectiveMetadata(durable) !== null).sort(compareDirectiveDurables);
  const profileDurables = activeCurrent
    .filter((durable) => parseDirectiveMetadata(durable) === null)
    .sort(compareProfileDurables)
    .slice(0, maxProfileDurables);

  const snapshot =
    profileDurables.length > 0 || directiveDurables.length > 0
      ? {
          id: randomUUID(),
          durableIds: profileDurables.map((durable) => durable.id),
          directiveIds: directiveDurables.map((durable) => durable.id),
          asOf,
          contentHash: buildProfileContentHash(profileDurables, directiveDurables),
          runId: options.runId,
          createdAt: asOf,
        }
      : null;

  return {
    summary: {
      profileDurableCount: profileDurables.length,
      directiveCount: directiveDurables.length,
      snapshotId: null,
      applied: false,
    },
    snapshot,
  };
}

/** Normalizes the configured profile size into the bounded v1 profile range. */
export function normalizeMaxProfileDurables(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_PROFILE_DURABLES;
  }

  return Math.min(MAX_PROFILE_DURABLES, Math.max(MIN_PROFILE_DURABLES, Math.trunc(value)));
}

/** Returns whether a durable is active and valid at the profile snapshot time. */
function isCurrentDurable(durable: Durable, asOfMs: number): boolean {
  return !durable.retired && !durable.superseded_by && isWithinValidityWindow(durable.valid_from, durable.valid_to, asOfMs);
}

/** Sorts profile durables by expiry, importance, quality, and recency. */
function compareProfileDurables(left: Durable, right: Durable): number {
  const expiryDelta = profileExpiryRank(right) - profileExpiryRank(left);
  if (expiryDelta !== 0) {
    return expiryDelta;
  }

  const importanceDelta = right.importance - left.importance;
  if (importanceDelta !== 0) {
    return importanceDelta;
  }

  const qualityDelta = right.quality_score - left.quality_score;
  if (qualityDelta !== 0) {
    return qualityDelta;
  }

  return right.created_at.localeCompare(left.created_at) || left.id.localeCompare(right.id);
}

/** Sorts directive durables by polarity, importance, and recency. */
function compareDirectiveDurables(left: Durable, right: Durable): number {
  const leftMetadata = parseDirectiveMetadata(left);
  const rightMetadata = parseDirectiveMetadata(right);
  const polarityDelta = directivePolarityRank(rightMetadata?.polarity) - directivePolarityRank(leftMetadata?.polarity);
  if (polarityDelta !== 0) {
    return polarityDelta;
  }

  const importanceDelta = right.importance - left.importance;
  if (importanceDelta !== 0) {
    return importanceDelta;
  }

  return right.created_at.localeCompare(left.created_at) || left.id.localeCompare(right.id);
}

/** Ranks profile expiry values for profile selection ordering. */
function profileExpiryRank(durable: Durable): number {
  if (durable.expiry === "core") {
    return 3;
  }
  if (durable.expiry === "permanent") {
    return 2;
  }
  return 1;
}

/** Ranks directive polarity values for directive selection ordering. */
function directivePolarityRank(polarity: Durable["directive_polarity"] | undefined): number {
  return polarity === "proactive" ? 2 : 1;
}

/** Builds a stable content hash for profile and directive snapshot inputs. */
function buildProfileContentHash(profileDurables: Durable[], directiveDurables: Durable[]): string {
  const payload = {
    profile: profileDurables.map(toHashableDurable),
    directives: directiveDurables.map(toHashableDurable),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Projects one durable into the fields that affect profile snapshot identity. */
function toHashableDurable(durable: Durable): Record<string, string | number | undefined> {
  return {
    id: durable.id,
    updated_at: durable.updated_at,
    content_hash: durable.content_hash,
    norm_content_hash: durable.norm_content_hash,
    importance: durable.importance,
    expiry: durable.expiry,
    directive_polarity: durable.directive_polarity,
    directive_trigger: durable.directive_trigger,
  };
}
