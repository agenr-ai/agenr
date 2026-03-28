const TUI_SESSION_KEY_PATTERN = /^agent:([^:]+):([^:]+)$/i;
const TUI_UUID_LANE_PATTERN = /^tui[a-z0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TUI_UUID_SUFFIX_PATTERN = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parsed TUI lane identity facts derived from an OpenClaw session key.
 */
export interface TuiLaneIdentity {
  /**
   * Owning OpenClaw agent identifier.
   */
  agentId: string;
  /**
   * Stable TUI continuity lane used for fallback predecessor matching.
   */
  stableLane: string;
  /**
   * Full runtime lane segment from the session key.
   */
  instanceLane: string;
}

/**
 * Parses TUI-style OpenClaw session keys into stable lane identity facts.
 *
 * Supported keys are limited to the TUI single-lane format
 * `agent:<agentId>:<lane>`. The parser treats `tui-<uuid>` variants as the
 * stable `tui` lane by stripping the UUID suffix, while preserving named TUI
 * lanes like `tui-1` and `tui-myproject`.
 *
 * @param sessionKey - OpenClaw session key to inspect.
 * @returns Parsed TUI identity facts, or `null` when the key is not TUI-shaped.
 */
export function parseTuiSessionKey(sessionKey: string): TuiLaneIdentity | null {
  const normalizedSessionKey = sessionKey.trim();
  if (normalizedSessionKey.length === 0) {
    return null;
  }

  const match = TUI_SESSION_KEY_PATTERN.exec(normalizedSessionKey);
  if (!match) {
    return null;
  }

  const [, agentId, instanceLane] = match;
  const normalizedAgentId = agentId?.trim();
  const normalizedInstanceLane = instanceLane?.trim();
  if (!normalizedAgentId || !normalizedInstanceLane || !normalizedInstanceLane.toLowerCase().startsWith("tui")) {
    return null;
  }

  const stableLane = TUI_UUID_LANE_PATTERN.test(normalizedInstanceLane) ? normalizedInstanceLane.replace(TUI_UUID_SUFFIX_PATTERN, "") : normalizedInstanceLane;

  return {
    agentId: normalizedAgentId,
    stableLane,
    instanceLane: normalizedInstanceLane,
  };
}
