import type { ReconcileShadowBucket } from "../../../core/dreaming/types.js";

const HIGH_CONFIDENCE_BACKFILL_THRESHOLD = 0.92;
const STRUCTURED_AUTO_APPLY_BACKFILL_THRESHOLD = 0.86;
const COMPACTED_SUPPORTED_AUTO_APPLY_BACKFILL_THRESHOLD = 0.78;
const PROPOSAL_CONFIDENCE_THRESHOLD = 0.75;
const SUPPORTED_PROPOSAL_CONFIDENCE_THRESHOLD = 0.65;
const MAX_CLEANUP_ENTITY_HINTS = 12;
const MAX_CLEANUP_CLAIM_KEY_HINTS = 8;
const CLAIM_KEY_CONCENTRATION_THRESHOLD = 25;
const CLAIM_KEY_CONCENTRATION_RATIO = 0.8;
const ENTITY_CONCENTRATION_THRESHOLD = 40;
const ENTITY_CONCENTRATION_RATIO = 0.85;
const COLLISION_SPIKE_THRESHOLD = 30;
const COLLISION_SPIKE_RATIO = 0.85;
/** Per-run ceiling on auto-applied duplicate exclusive-slot supersessions. */
export const MAX_AUTO_DUPLICATE_SLOT_COLLAPSES_PER_RUN = 20;

const CLAIM_KEY_PROGRESS_INTERVAL_MS = 5_000;
const CLAIM_KEY_PROGRESS_VERBOSE_INTERVAL_MS = 2_000;
const CLAIM_KEY_PROGRESS_EVERY_DURABLES = 250;
const CLAIM_KEY_PROGRESS_EVERY_VERBOSE_DURABLES = 50;
const SHADOW_RESONANCE_MIN_FAMILY_REUSE_COUNT = 20;
const SHADOW_RESONANCE_MIN_GROUNDED_RATIO = 0.7;
const SHADOW_RESONANCE_MIN_CONFIDENCE = 0.74;
const USER_METADATA_ENTITY_ALIASES = new Set(["i", "me", "myself", "person", "the_user", "user"]);
const PROJECT_METADATA_ENTITY_ALIASES = new Set(["app", "application", "project", "the_project", "this_project", "workspace"]);

/** Classifies the structural evidence that can promote a missing-key backfill. */
export type MissingBackfillPromotionClass =
  | "trusted_exact_reuse_grounded"
  | "trusted_family_template_grounded"
  | "trusted_family_stable_slot"
  | "trusted_family_grounded_alignment";

/** Identifies the threshold lane used for one missing-key backfill decision. */
export type MissingBackfillPromotionLane =
  | "high_confidence_preview"
  | "structured_supported"
  | "compacted_supported"
  | "deterministic_repair"
  | "metadata_rewrite";

const SHADOW_BUCKET_ORDER: ReconcileShadowBucket[] = [
  "high_density_grounded_family",
  "large_grounding_diluted_grounded_family",
  "thin_grounded_family_tail",
  "relaxed_one_sibling_stable_slot",
  "other_grounded_family_alignment",
];

export {
  CLAIM_KEY_CONCENTRATION_RATIO,
  CLAIM_KEY_CONCENTRATION_THRESHOLD,
  CLAIM_KEY_PROGRESS_EVERY_DURABLES,
  CLAIM_KEY_PROGRESS_EVERY_VERBOSE_DURABLES,
  CLAIM_KEY_PROGRESS_INTERVAL_MS,
  CLAIM_KEY_PROGRESS_VERBOSE_INTERVAL_MS,
  COLLISION_SPIKE_RATIO,
  COLLISION_SPIKE_THRESHOLD,
  COMPACTED_SUPPORTED_AUTO_APPLY_BACKFILL_THRESHOLD,
  ENTITY_CONCENTRATION_RATIO,
  ENTITY_CONCENTRATION_THRESHOLD,
  HIGH_CONFIDENCE_BACKFILL_THRESHOLD,
  MAX_CLEANUP_CLAIM_KEY_HINTS,
  MAX_CLEANUP_ENTITY_HINTS,
  PROJECT_METADATA_ENTITY_ALIASES,
  PROPOSAL_CONFIDENCE_THRESHOLD,
  SHADOW_BUCKET_ORDER,
  SHADOW_RESONANCE_MIN_CONFIDENCE,
  SHADOW_RESONANCE_MIN_FAMILY_REUSE_COUNT,
  SHADOW_RESONANCE_MIN_GROUNDED_RATIO,
  STRUCTURED_AUTO_APPLY_BACKFILL_THRESHOLD,
  SUPPORTED_PROPOSAL_CONFIDENCE_THRESHOLD,
  USER_METADATA_ENTITY_ALIASES,
};
