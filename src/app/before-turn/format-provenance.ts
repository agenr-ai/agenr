import type { projectClaimCentricRecallEntry } from "../recall/claim-centric.js";

/**
 * Formats the projected claim-centric provenance shape into one compact string.
 *
 * @param provenance - Claim-centric projected provenance metadata.
 * @returns Compact provenance summary, or undefined when none exists.
 */
export function formatProjectedProvenance(provenance: ReturnType<typeof projectClaimCentricRecallEntry>["provenance"]): string | undefined {
  const parts = [
    provenance.supersededById ? `superseded_by=${provenance.supersededById}` : undefined,
    provenance.supersessionKind ? `kind=${provenance.supersessionKind}` : undefined,
    provenance.supersessionReason ? `reason=${provenance.supersessionReason}` : undefined,
    provenance.supportSourceKind ? `support=${provenance.supportSourceKind}` : undefined,
    provenance.supportMode ? `support_mode=${provenance.supportMode}` : undefined,
    provenance.supportObservedAt ? `observed=${provenance.supportObservedAt}` : undefined,
    provenance.supportLocator ? `locator=${provenance.supportLocator}` : undefined,
  ].filter((value): value is string => value !== undefined);

  return parts.length > 0 ? parts.join(" | ") : undefined;
}
