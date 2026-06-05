import type { ReconcileShadowBucket } from "../../../../core/dreaming/types.js";
import { normalizeClaimKeySegment } from "../../../../core/claim-key.js";

export function normalizeOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function normalizeStringArray(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

export function normalizeOptionalNonNegativeCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

export function elapsedMs(startedAtMs: number, nowMs = Date.now()): number {
  return Math.max(0, nowMs - startedAtMs);
}

export function countSetOverlap(left: Set<string>, right: Iterable<string>): number {
  let count = 0;
  for (const value of right) {
    if (left.has(value)) {
      count += 1;
    }
  }

  return count;
}

export function normalizeMetadataEntity(value: string | undefined): string | null {
  const normalized = value ? normalizeClaimKeySegment(value) : "";
  if (normalized.length === 0 || !/[a-z]/u.test(normalized)) {
    return null;
  }

  return normalized;
}

export function describeShadowBucket(bucket: ReconcileShadowBucket): string {
  switch (bucket) {
    case "high_density_grounded_family":
      return "high-density grounded-family";
    case "large_grounding_diluted_grounded_family":
      return "large grounding-diluted grounded-family";
    case "thin_grounded_family_tail":
      return "thin grounded-family tail";
    case "relaxed_one_sibling_stable_slot":
      return "relaxed one-sibling stable-slot";
    case "other_grounded_family_alignment":
      return "other grounded-family alignment";
  }
}
