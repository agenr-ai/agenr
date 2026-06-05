import { isTrustedClaimKeyForCleanup } from "../../../../core/claim-key.js";
import type { Durable } from "../../../../core/types.js";
import { normalizeStringArray } from "./utils.js";

/** Finds subject/type groups that contain mixed or missing claim keys. */
export function findMixedKeyGroups(
  durables: Durable[],
  coveredClaimKeys: ReadonlySet<string> = new Set<string>(),
): Array<{ groupKey: string; durables: Durable[]; proposedClaimKey: string | null }> {
  const groups = new Map<string, Durable[]>();

  for (const durable of durables) {
    const normalizedSubject = durable.subject.trim().toLowerCase();
    if (normalizedSubject.length === 0) {
      continue;
    }

    const groupKey = `${normalizedSubject}::${durable.type}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.push(durable);
      continue;
    }

    groups.set(groupKey, [durable]);
  }

  return [...groups.entries()]
    .flatMap(([groupKey, groupDurables]) => {
      if (groupDurables.length < 2) {
        return [];
      }

      const claimKeys = normalizeStringArray(groupDurables.flatMap((durable) => (durable.claim_key ? [durable.claim_key] : [])));
      const hasMissing = groupDurables.some((durable) => !durable.claim_key);
      const distinctClaimKeyCount = claimKeys.length;
      if (!hasMissing && distinctClaimKeyCount <= 1) {
        return [];
      }
      if (!hasMissing && distinctClaimKeyCount > 1 && claimKeys.every((claimKey) => coveredClaimKeys.has(claimKey))) {
        return [];
      }

      const trustedClaimKeys = claimKeys.filter((claimKey) => isTrustedClaimKeyForCleanup(claimKey));
      const proposedClaimKey = trustedClaimKeys.length === 1 ? (trustedClaimKeys[0] ?? null) : null;
      return [
        {
          groupKey,
          durables: groupDurables,
          proposedClaimKey,
        },
      ];
    })
    .sort((left, right) => left.groupKey.localeCompare(right.groupKey));
}

/** Builds proposal rationale for a mixed subject/type claim-key group. */
export function buildMixedGroupRationale(group: { groupKey: string; durables: Durable[]; proposedClaimKey: string | null }): string {
  const currentClaimKeys = normalizeStringArray(group.durables.flatMap((durable) => (durable.claim_key ? [durable.claim_key] : [])));
  if (group.proposedClaimKey) {
    return (
      `Durables sharing subject/type group "${group.groupKey}" use mixed or missing claim keys. ` +
      `The only trusted canonical family already present is "${group.proposedClaimKey}", so it is the conservative proposed target for later adjudication. ` +
      `Current non-null keys: ${currentClaimKeys.join(", ") || "(none)"}.`
    );
  }

  return (
    `Durables sharing subject/type group "${group.groupKey}" use mixed or missing claim keys, but the group does not expose one uniquely trusted canonical target. ` +
    `Current non-null keys: ${currentClaimKeys.join(", ") || "(none)"}.`
  );
}
