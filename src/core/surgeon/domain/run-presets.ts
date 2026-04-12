import type { SurgeonPassType } from "./pass-types.js";

const AUTONOMOUS_SURGEON_SEQUENCE = ["claim_key_quality", "supersession", "retirement"] as const;

/**
 * Supported implemented single-pass surgeon identifiers.
 */
export type ImplementedSurgeonPass = Extract<SurgeonPassType, (typeof AUTONOMOUS_SURGEON_SEQUENCE)[number]>;

export { AUTONOMOUS_SURGEON_SEQUENCE };

/**
 * Returns the ordered pass sequence used by autonomous surgeon runs.
 *
 * @returns Ordered implemented pass sequence.
 */
export function getAutonomousSurgeonPassSequence(): ImplementedSurgeonPass[] {
  return [...AUTONOMOUS_SURGEON_SEQUENCE];
}
