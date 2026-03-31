import { describe, expect, it } from "vitest";

import { parseOpenClawSessionContinuityKey } from "../../../../src/adapters/openclaw/session/session-key-parser.js";

describe("parseOpenClawSessionContinuityKey", () => {
  it("parses the default main session key", () => {
    expect(parseOpenClawSessionContinuityKey("agent:main:main")).toEqual({
      agentId: "main",
      kind: "main",
      stableLane: "main",
      instanceLane: "main",
      eligible: true,
    });
  });

  it("parses a custom main session key only when mainKey matches", () => {
    expect(
      parseOpenClawSessionContinuityKey("agent:main:desk", {
        mainKey: "desk",
      }),
    ).toEqual({
      agentId: "main",
      kind: "main",
      stableLane: "desk",
      instanceLane: "desk",
      eligible: true,
    });

    expect(
      parseOpenClawSessionContinuityKey("agent:main:desk", {
        mainKey: "main",
      }),
    ).toEqual({
      agentId: "main",
      kind: "unknown",
      stableLane: null,
      instanceLane: null,
      eligible: false,
    });
  });

  it("parses tui session keys through the existing tui lane normalizer", () => {
    expect(parseOpenClawSessionContinuityKey("agent:main:tui-123e4567-e89b-12d3-a456-426614174000")).toEqual({
      agentId: "main",
      kind: "tui",
      stableLane: "tui",
      instanceLane: "tui-123e4567-e89b-12d3-a456-426614174000",
      eligible: true,
    });
    expect(parseOpenClawSessionContinuityKey("agent:main:tui-1")).toEqual({
      agentId: "main",
      kind: "tui",
      stableLane: "tui-1",
      instanceLane: "tui-1",
      eligible: true,
    });
  });

  it("parses supported direct-session shapes", () => {
    expect(parseOpenClawSessionContinuityKey("agent:main:direct:123")).toMatchObject({
      agentId: "main",
      kind: "direct",
      stableLane: "direct:123",
      eligible: true,
    });
    expect(parseOpenClawSessionContinuityKey("agent:main:telegram:direct:123")).toMatchObject({
      agentId: "main",
      kind: "direct",
      stableLane: "telegram:direct:123",
      eligible: true,
    });
    expect(parseOpenClawSessionContinuityKey("agent:main:telegram:default:direct:123")).toMatchObject({
      agentId: "main",
      kind: "direct",
      stableLane: "telegram:default:direct:123",
      eligible: true,
    });
  });

  it("parses supported group and channel session shapes", () => {
    expect(parseOpenClawSessionContinuityKey("agent:main:telegram:group:-100123")).toMatchObject({
      agentId: "main",
      kind: "group",
      stableLane: "telegram:group:-100123",
      eligible: true,
    });
    expect(parseOpenClawSessionContinuityKey("agent:main:telegram:group:-100123:topic:42")).toMatchObject({
      agentId: "main",
      kind: "group",
      stableLane: "telegram:group:-100123:topic:42",
      eligible: true,
    });
    expect(parseOpenClawSessionContinuityKey("agent:main:discord:channel:123")).toMatchObject({
      agentId: "main",
      kind: "channel",
      stableLane: "discord:channel:123",
      eligible: true,
    });
    expect(parseOpenClawSessionContinuityKey("agent:main:discord:channel:123:thread:456")).toMatchObject({
      agentId: "main",
      kind: "channel",
      stableLane: "discord:channel:123:thread:456",
      eligible: true,
    });
  });

  it("parses subagent and acp keys as ineligible", () => {
    expect(parseOpenClawSessionContinuityKey("agent:main:subagent:123")).toMatchObject({
      agentId: "main",
      kind: "subagent",
      stableLane: "subagent:123",
      eligible: false,
    });
    expect(parseOpenClawSessionContinuityKey("agent:main:acp:123")).toMatchObject({
      agentId: "main",
      kind: "acp",
      stableLane: "acp:123",
      eligible: false,
    });
  });

  it("fails closed for malformed or unsupported keys", () => {
    expect(parseOpenClawSessionContinuityKey("")).toEqual({
      agentId: null,
      kind: "unknown",
      stableLane: null,
      instanceLane: null,
      eligible: false,
    });
    expect(parseOpenClawSessionContinuityKey("agent:main:telegram:group:-100123:thread:42")).toMatchObject({
      agentId: "main",
      kind: "unknown",
      eligible: false,
    });
    expect(parseOpenClawSessionContinuityKey("agent:main:discord:slash:123")).toMatchObject({
      agentId: "main",
      kind: "unknown",
      eligible: false,
    });
  });
});
