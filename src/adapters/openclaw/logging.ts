/**
 * Formats stable session identifiers for OpenClaw adapter log messages.
 *
 * @param sessionId - Ephemeral OpenClaw session UUID when available.
 * @param sessionKey - Stable OpenClaw session key when available.
 * @returns Compact session identity text for logs.
 */
export function formatSessionContext(sessionId?: string, sessionKey?: string): string {
  const normalizedSessionId = sessionId?.trim();
  const normalizedSessionKey = sessionKey?.trim();
  if (normalizedSessionId && normalizedSessionKey) {
    return `session=${normalizedSessionId} key=${normalizedSessionKey}`;
  }

  if (normalizedSessionId) {
    return `session=${normalizedSessionId}`;
  }

  if (normalizedSessionKey) {
    return `key=${normalizedSessionKey}`;
  }

  return "session=unknown";
}

/**
 * Formats unknown failures into stable loggable strings.
 *
 * @param error - Unknown thrown value.
 * @returns Human-readable error text.
 */
export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
