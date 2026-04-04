import type { SurgeonPassType } from "./pass-types.js";

const SURGEON_RUN_PRESETS = ["claim-key-only", "structural", "full"] as const;

/**
 * Supported composed surgeon run presets.
 */
export type SurgeonRunPreset = (typeof SURGEON_RUN_PRESETS)[number];

/**
 * Supported implemented single-pass surgeon identifiers.
 */
export type ImplementedSurgeonPass = Extract<SurgeonPassType, "claim_key_quality" | "retirement" | "supersession">;

export { SURGEON_RUN_PRESETS };

/**
 * Checks whether a string is a supported surgeon run preset.
 *
 * @param value - Candidate preset identifier.
 * @returns True when the value is a known preset.
 */
export function isSurgeonRunPreset(value: string): value is SurgeonRunPreset {
  return (SURGEON_RUN_PRESETS as readonly string[]).includes(value);
}

/**
 * Resolves a composed preset into its ordered pass sequence.
 *
 * @param preset - Named surgeon run preset.
 * @returns Ordered implemented pass sequence.
 */
export function resolveSurgeonPassSequence(preset: SurgeonRunPreset): ImplementedSurgeonPass[] {
  switch (preset) {
    case "claim-key-only":
      return ["claim_key_quality"];
    case "structural":
      return ["claim_key_quality", "supersession"];
    case "full":
      return ["claim_key_quality", "supersession", "retirement"];
  }
}
