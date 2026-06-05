import { DREAM_TIERS, type DreamTier } from "../types.js";

export { DREAM_TIERS };

/**
 * Checks whether a string is a valid dreaming run tier.
 *
 * @param value - Candidate tier identifier.
 * @returns True when the value is a known dreaming tier.
 */
export function isDreamTier(value: string): value is DreamTier {
  return (DREAM_TIERS as readonly string[]).includes(value);
}
export type { DreamTier } from "../types.js";
