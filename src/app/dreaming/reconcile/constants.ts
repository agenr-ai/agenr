import type { ReconcileShadowBucket } from "../../../core/dreaming/types.js";

export const HIGH_CONFIDENCE_BACKFILL_THRESHOLD = 0.92;
export const STRUCTURED_AUTO_APPLY_BACKFILL_THRESHOLD = 0.86;
export const COMPACTED_SUPPORTED_AUTO_APPLY_BACKFILL_THRESHOLD = 0.78;
export const PROPOSAL_CONFIDENCE_THRESHOLD = 0.75;
export const SUPPORTED_PROPOSAL_CONFIDENCE_THRESHOLD = 0.65;
export const MAX_CLEANUP_ENTITY_HINTS = 12;
export const MAX_CLEANUP_CLAIM_KEY_HINTS = 8;
export const CLAIM_KEY_CONCENTRATION_THRESHOLD = 25;
export const CLAIM_KEY_CONCENTRATION_RATIO = 0.8;
export const ENTITY_CONCENTRATION_THRESHOLD = 40;
export const ENTITY_CONCENTRATION_RATIO = 0.85;
export const COLLISION_SPIKE_THRESHOLD = 30;
export const COLLISION_SPIKE_RATIO = 0.85;
export const CLAIM_KEY_PROGRESS_INTERVAL_MS = 5_000;
export const CLAIM_KEY_PROGRESS_VERBOSE_INTERVAL_MS = 2_000;
export const CLAIM_KEY_PROGRESS_EVERY_DURABLES = 250;
export const CLAIM_KEY_PROGRESS_EVERY_VERBOSE_DURABLES = 50;
export const SHADOW_RESONANCE_MIN_FAMILY_REUSE_COUNT = 20;
export const SHADOW_RESONANCE_MIN_GROUNDED_RATIO = 0.7;
export const SHADOW_RESONANCE_MIN_CONFIDENCE = 0.74;
export const USER_METADATA_ENTITY_ALIASES = new Set(["i", "me", "myself", "person", "the_user", "user"]);
export const PROJECT_METADATA_ENTITY_ALIASES = new Set(["app", "application", "project", "the_project", "this_project", "workspace"]);

export type MissingBackfillPromotionClass =
  | "trusted_exact_reuse_grounded"
  | "trusted_family_template_grounded"
  | "trusted_family_stable_slot"
  | "trusted_family_grounded_alignment";

export type MissingBackfillPromotionLane =
  | "high_confidence_preview"
  | "structured_supported"
  | "compacted_supported"
  | "deterministic_repair"
  | "metadata_rewrite";

export const SHADOW_BUCKET_ORDER: ReconcileShadowBucket[] = [
  "high_density_grounded_family",
  "large_grounding_diluted_grounded_family",
  "thin_grounded_family_tail",
  "relaxed_one_sibling_stable_slot",
  "other_grounded_family_alignment",
];
