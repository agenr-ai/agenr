import type { DurableKind } from "../types.js";

/** Host prefixes used by live `agenr_store` writes, not dreaming extract inserts. */
const HOST_STORE_SOURCE_PREFIXES = ["skeln-session:", "openclaw-session:"] as const;

/**
 * One host-store durable already written during the episode session window.
 */
export interface DreamSessionStoreDurable {
  type: DurableKind;
  subject: string;
  content: string;
  claimKey: string | null;
  normContentHash: string;
}

/**
 * Returns whether one durable source locator came from a live host store path.
 *
 * @param sourceFile - Persisted durable `source_file` value.
 * @returns `true` when the row was written through OpenClaw or Skeln store tooling.
 */
export function isHostStoreSourceFile(sourceFile: string | undefined): boolean {
  const normalized = sourceFile?.trim();
  if (!normalized) {
    return false;
  }

  return HOST_STORE_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Returns whether one host-store source locator belongs to the given session id.
 *
 * @param sourceFile - Persisted durable `source_file` value.
 * @param sessionId - Episode or host session identifier.
 * @returns `true` when the locator references the session.
 */
export function sourceFileMatchesSession(sourceFile: string | undefined, sessionId: string): boolean {
  const normalizedSource = sourceFile?.trim();
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSource || normalizedSessionId.length === 0) {
    return false;
  }

  return normalizedSource.includes(normalizedSessionId);
}
