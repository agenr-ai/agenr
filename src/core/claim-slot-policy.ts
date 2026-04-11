import { normalizeClaimKey } from "./claim-key.js";

/**
 * Runtime slot-policy classes used by claim-centric read surfaces.
 */
export type ClaimSlotPolicy = "exclusive" | "multivalued";

/**
 * Data-driven slot-policy overrides keyed by canonical claim-key attribute head.
 */
export interface ClaimSlotPolicyConfig {
  /** Optional attribute-head policy overrides such as `integration -> exclusive`. */
  attributeHeads?: Readonly<Record<string, ClaimSlotPolicy>>;
}

/**
 * Structured slot-policy resolution facts for one canonical claim key.
 */
export interface ResolvedClaimSlotPolicy {
  /** Canonical normalized claim key when resolution succeeded. */
  claimKey?: string;
  /** Canonical entity segment when available. */
  entity?: string;
  /** Canonical attribute segment when available. */
  attribute?: string;
  /** Leading attribute token used for policy lookup. */
  attributeHead?: string;
  /** Effective runtime slot policy. */
  policy: ClaimSlotPolicy;
  /** Human-readable explanation of how the policy was chosen. */
  reason: string;
}

const MULTIVALUED_ATTRIBUTE_HEADS = new Set(["access", "dependency", "guide", "integration", "preference", "requirement", "support"]);

/**
 * Resolves the runtime slot policy for one optional claim key.
 *
 * The first Phase 3 pass keeps this as a lightweight runtime registry keyed by
 * the canonical attribute head. That keeps claim keys as exact slot identity
 * while letting read-time shaping distinguish exclusive slots from slots that
 * may legitimately contain multiple concurrent truths.
 *
 * @param claimKey - Optional canonical or raw claim key.
 * @param config - Optional runtime policy overrides keyed by attribute head.
 * @returns Structured slot-policy resolution metadata.
 */
export function resolveClaimSlotPolicy(claimKey: string | undefined, config?: ClaimSlotPolicyConfig): ResolvedClaimSlotPolicy {
  const normalized = normalizeClaimKey(claimKey ?? "");
  if (!normalized.ok) {
    return {
      policy: "exclusive",
      reason: "No canonical claim key was available, so the slot policy defaulted to exclusive.",
    };
  }

  const { claimKey: canonicalClaimKey, entity, attribute } = normalized.value;
  const attributeHead = attribute.split("_")[0] ?? attribute;
  const configuredPolicy = resolveConfiguredAttributeHeadPolicy(attributeHead, config);
  if (configuredPolicy) {
    return {
      claimKey: canonicalClaimKey,
      entity,
      attribute,
      attributeHead,
      policy: configuredPolicy,
      reason: `Attribute head "${attributeHead}" is configured as ${configuredPolicy} by runtime policy.`,
    };
  }

  if (MULTIVALUED_ATTRIBUTE_HEADS.has(attributeHead)) {
    return {
      claimKey: canonicalClaimKey,
      entity,
      attribute,
      attributeHead,
      policy: "multivalued",
      reason: `Attribute head "${attributeHead}" is registered as multivalued.`,
    };
  }

  return {
    claimKey: canonicalClaimKey,
    entity,
    attribute,
    attributeHead,
    policy: "exclusive",
    reason: `Attribute head "${attributeHead}" defaults to exclusive current-state shaping.`,
  };
}

/**
 * Resolves one optional runtime override for an attribute head.
 *
 * @param attributeHead - Canonical claim-key attribute head.
 * @param config - Optional runtime policy overrides.
 * @returns Configured policy when one exists.
 */
function resolveConfiguredAttributeHeadPolicy(attributeHead: string, config: ClaimSlotPolicyConfig | undefined): ClaimSlotPolicy | undefined {
  const configuredPolicy = config?.attributeHeads?.[attributeHead];
  if (configuredPolicy) {
    return configuredPolicy;
  }

  const loweredAttributeHead = attributeHead.toLowerCase();
  if (loweredAttributeHead === attributeHead) {
    return undefined;
  }

  return config?.attributeHeads?.[loweredAttributeHead];
}
