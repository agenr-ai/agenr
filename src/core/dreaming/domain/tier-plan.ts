import type { DreamTier } from "../types.js";

/** Explicit stage toggles for one dreaming run tier. */
export interface TierStagePlan {
  runReconcile: boolean;
  runPrune: boolean;
  runReap: boolean;
}

/** Returns which pipeline stages run for the requested dreaming tier. */
export function resolveTierStages(tier: DreamTier): TierStagePlan {
  switch (tier) {
    case "light":
      return {
        runReconcile: false,
        runPrune: false,
        runReap: false,
      };
    case "standard":
    case "deep":
      return {
        runReconcile: true,
        runPrune: true,
        runReap: true,
      };
  }
}
