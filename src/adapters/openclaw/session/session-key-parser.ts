import { parseTuiSessionKey } from "./tui-lane.js";

/**
 * Continuity-relevant session key kinds supported by the OpenClaw adapter.
 */
export type OpenClawSessionContinuityKind = "main" | "tui" | "direct" | "group" | "channel" | "subagent" | "acp" | "unknown";

/**
 * Parsed continuity identity facts derived from one OpenClaw session key.
 */
export interface OpenClawSessionContinuityIdentity {
  /**
   * Owning OpenClaw agent identifier when derivable from the key.
   */
  agentId: string | null;
  /**
   * Normalized continuity kind used for predecessor matching policy.
   */
  kind: OpenClawSessionContinuityKind;
  /**
   * Stable continuity lane used when comparing two sessions.
   */
  stableLane: string | null;
  /**
   * Full runtime lane represented by the session key.
   */
  instanceLane: string | null;
  /**
   * Reports whether this key kind is allowed to participate in continuity.
   */
  eligible: boolean;
}

const AGENT_SESSION_KEY_PATTERN = /^agent:([^:]+):(.+)$/i;
const TOPIC_SUFFIX_TOKENS = 2;
const THREAD_SUFFIX_TOKENS = 2;
const ACCOUNT_SCOPED_DIRECT_MIN_TOKENS = 4;
const CHANNEL_SCOPED_MIN_TOKENS = 3;

/**
 * Parses the current OpenClaw session-key shapes used for continuity lookup.
 *
 * The parser is intentionally narrow. Unsupported or malformed shapes are
 * treated as `unknown` so predecessor resolution can fail closed.
 *
 * @param sessionKey - OpenClaw session key to inspect.
 * @param params - Optional parser settings.
 * @returns Normalized continuity identity for the supplied key.
 */
export function parseOpenClawSessionContinuityKey(
  sessionKey: string,
  params?: {
    mainKey?: string;
  },
): OpenClawSessionContinuityIdentity {
  const normalizedSessionKey = sessionKey.trim();
  const normalizedMainKey = normalizeMainKey(params?.mainKey);
  if (normalizedSessionKey.length === 0) {
    return buildUnknownIdentity();
  }

  const tuiIdentity = parseTuiSessionKey(normalizedSessionKey);
  if (tuiIdentity) {
    return {
      agentId: tuiIdentity.agentId,
      kind: "tui",
      stableLane: tuiIdentity.stableLane,
      instanceLane: tuiIdentity.instanceLane,
      eligible: true,
    };
  }

  const agentMatch = AGENT_SESSION_KEY_PATTERN.exec(normalizedSessionKey);
  if (!agentMatch) {
    return buildUnknownIdentity();
  }

  const [, rawAgentId, rawLane] = agentMatch;
  const agentId = rawAgentId?.trim() ?? "";
  const lane = rawLane?.trim() ?? "";
  if (!agentId || !lane) {
    return buildUnknownIdentity();
  }

  if (lane === normalizedMainKey) {
    return {
      agentId,
      kind: "main",
      stableLane: normalizedMainKey,
      instanceLane: normalizedMainKey,
      eligible: true,
    };
  }

  const tokens = lane
    .split(":")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return buildUnknownIdentity(agentId);
  }

  if (tokens[0] === "subagent" && tokens.length >= 2) {
    return buildIneligibleIdentity(agentId, "subagent", lane);
  }

  if (tokens[0] === "acp" && tokens.length >= 2) {
    return buildIneligibleIdentity(agentId, "acp", lane);
  }

  if (tokens[0] === "direct" && tokens.length >= 2) {
    return buildEligibleIdentity(agentId, "direct", lane);
  }

  if (tokens.length >= ACCOUNT_SCOPED_DIRECT_MIN_TOKENS && tokens[2] === "direct") {
    return buildEligibleIdentity(agentId, "direct", lane);
  }

  if (tokens.length >= CHANNEL_SCOPED_MIN_TOKENS && tokens[1] === "direct") {
    return buildEligibleIdentity(agentId, "direct", lane);
  }

  if (isSupportedGroupLane(tokens)) {
    return buildEligibleIdentity(agentId, "group", lane);
  }

  if (isSupportedChannelLane(tokens)) {
    return buildEligibleIdentity(agentId, "channel", lane);
  }

  return buildUnknownIdentity(agentId);
}

/**
 * Detects group lanes with an optional Telegram-style topic suffix.
 *
 * @param tokens - Non-empty agent-scoped lane tokens.
 * @returns `true` when the tokens represent a supported group key.
 */
function isSupportedGroupLane(tokens: string[]): boolean {
  if (tokens.length < CHANNEL_SCOPED_MIN_TOKENS || tokens[1] !== "group" || !tokens[0] || !tokens[2]) {
    return false;
  }

  if (tokens.length === CHANNEL_SCOPED_MIN_TOKENS) {
    return true;
  }

  return tokens.length === CHANNEL_SCOPED_MIN_TOKENS + TOPIC_SUFFIX_TOKENS && tokens[3] === "topic" && Boolean(tokens[4]);
}

/**
 * Detects channel lanes with an optional thread suffix.
 *
 * @param tokens - Non-empty agent-scoped lane tokens.
 * @returns `true` when the tokens represent a supported channel key.
 */
function isSupportedChannelLane(tokens: string[]): boolean {
  if (tokens.length < CHANNEL_SCOPED_MIN_TOKENS || tokens[1] !== "channel" || !tokens[0] || !tokens[2]) {
    return false;
  }

  if (tokens.length === CHANNEL_SCOPED_MIN_TOKENS) {
    return true;
  }

  return tokens.length === CHANNEL_SCOPED_MIN_TOKENS + THREAD_SUFFIX_TOKENS && tokens[3] === "thread" && Boolean(tokens[4]);
}

/**
 * Normalizes optional main-key configuration into the default OpenClaw main key.
 *
 * @param mainKey - Configured OpenClaw main key.
 * @returns Trimmed main key, or `"main"` when unset.
 */
function normalizeMainKey(mainKey: string | undefined): string {
  return mainKey?.trim() || "main";
}

/**
 * Creates one parsed identity for supported continuity kinds.
 *
 * @param agentId - Parsed agent identifier.
 * @param kind - Supported continuity kind.
 * @param lane - Stable and runtime lane text.
 * @returns Parsed eligible continuity identity.
 */
function buildEligibleIdentity(
  agentId: string,
  kind: Extract<OpenClawSessionContinuityKind, "direct" | "group" | "channel">,
  lane: string,
): OpenClawSessionContinuityIdentity {
  return {
    agentId,
    kind,
    stableLane: lane,
    instanceLane: lane,
    eligible: true,
  };
}

/**
 * Creates one parsed identity for supported but ineligible key kinds.
 *
 * @param agentId - Parsed agent identifier.
 * @param kind - Supported but ineligible key kind.
 * @param lane - Stable and runtime lane text.
 * @returns Parsed ineligible continuity identity.
 */
function buildIneligibleIdentity(
  agentId: string,
  kind: Extract<OpenClawSessionContinuityKind, "subagent" | "acp">,
  lane: string,
): OpenClawSessionContinuityIdentity {
  return {
    agentId,
    kind,
    stableLane: lane,
    instanceLane: lane,
    eligible: false,
  };
}

/**
 * Creates one parsed identity for malformed or unsupported session keys.
 *
 * @param agentId - Parsed agent identifier when available.
 * @returns Parsed unknown continuity identity.
 */
function buildUnknownIdentity(agentId: string | null = null): OpenClawSessionContinuityIdentity {
  return {
    agentId,
    kind: "unknown",
    stableLane: null,
    instanceLane: null,
    eligible: false,
  };
}
