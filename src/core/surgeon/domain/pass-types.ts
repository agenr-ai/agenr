const SURGEON_PASS_TYPES = ["claim_key_quality", "retirement", "dedup", "supersession", "auto"] as const;

/**
 * Supported surgeon pass identifiers.
 */
export type SurgeonPassType = (typeof SURGEON_PASS_TYPES)[number];

export { SURGEON_PASS_TYPES };

/**
 * Checks whether a string is a valid surgeon pass type.
 *
 * @param value - Candidate pass identifier.
 * @returns True when the value is a known surgeon pass type.
 */
export function isSurgeonPassType(value: string): value is SurgeonPassType {
  return (SURGEON_PASS_TYPES as readonly string[]).includes(value);
}

/**
 * Checks whether a surgeon pass is implemented in the current v1 MVP.
 *
 * @param pass - Pass type to inspect.
 * @returns True only for currently implemented pass types.
 */
export function isImplementedSurgeonPass(pass: SurgeonPassType): pass is Extract<SurgeonPassType, "claim_key_quality" | "retirement" | "supersession"> {
  return pass === "claim_key_quality" || pass === "retirement" || pass === "supersession";
}
