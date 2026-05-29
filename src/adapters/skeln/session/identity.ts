export { resolveSessionIdentityKey } from "../../../app/plugin-runtime/session-tracking.js";

/**
 * Derives one stable recall/session key from Skeln session identity and cwd.
 *
 * The key scopes durable recall and store provenance to one Skeln session
 * lifetime within one working directory.
 *
 * @param sessionId - Ephemeral Skeln session identifier.
 * @param cwd - Active session working directory.
 * @returns Stable session key used by agenr recall and store surfaces.
 */
export function resolveSkelnSessionKey(sessionId: string, cwd: string): string {
  const normalizedSessionId = sessionId.trim();
  const normalizedCwd = cwd.trim();
  if (!normalizedSessionId) {
    throw new Error("Skeln session id is required to derive a session key.");
  }

  if (!normalizedCwd) {
    return `skeln:session:${normalizedSessionId}`;
  }

  return `skeln:session:${normalizedSessionId}:cwd:${normalizedCwd}`;
}
