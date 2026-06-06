import { computeNormContentHash } from "../store/hashing.js";
import type { Durable } from "../types.js";
import type { DreamSessionStoreDurable } from "./session-store-guard.js";

/**
 * Session-scoped dedup context derived from live host-store durables.
 */
export interface DreamSessionStoreContext {
  claimKeys: Set<string>;
  normContentHashes: Set<string>;
}

/**
 * Maps persisted host-store durables into prompt and dedup context.
 *
 * @param durables - Live host-store durables from one episode session window.
 * @returns Slim durable summaries for dreaming extract.
 */
export function toDreamSessionStoreDurables(durables: Durable[]): DreamSessionStoreDurable[] {
  return durables.map((durable) => ({
    type: durable.type,
    subject: durable.subject,
    content: durable.content,
    claimKey: durable.claim_key?.trim() ? durable.claim_key : null,
    normContentHash: durable.norm_content_hash?.trim() || computeNormContentHash(durable.content),
  }));
}

/**
 * Builds dedup sets from live host-store durables in one session window.
 *
 * @param durables - Live host-store durables from one episode session window.
 * @returns Claim-key and normalized-content hash sets for classification.
 */
export function buildDreamSessionStoreContext(durables: DreamSessionStoreDurable[]): DreamSessionStoreContext {
  const claimKeys = new Set<string>();
  const normContentHashes = new Set<string>();

  for (const durable of durables) {
    normContentHashes.add(durable.normContentHash);
    if (durable.claimKey) {
      claimKeys.add(durable.claimKey);
    }
  }

  return { claimKeys, normContentHashes };
}
