import { describe, expect, it } from "vitest";

import { parseTuiSessionKey } from "../../../../src/adapters/openclaw/session/tui-lane.js";

describe("parseTuiSessionKey", () => {
  it("normalizes tui uuid lanes to the stable tui bucket", () => {
    expect(parseTuiSessionKey("agent:main:tui-123e4567-e89b-12d3-a456-426614174000")).toEqual({
      agentId: "main",
      stableLane: "tui",
      instanceLane: "tui-123e4567-e89b-12d3-a456-426614174000",
    });
  });

  it("preserves named tui lanes that do not end with a uuid suffix", () => {
    expect(parseTuiSessionKey("agent:main:tui-1")).toEqual({
      agentId: "main",
      stableLane: "tui-1",
      instanceLane: "tui-1",
    });
    expect(parseTuiSessionKey("agent:main:tui-myproject")).toEqual({
      agentId: "main",
      stableLane: "tui-myproject",
      instanceLane: "tui-myproject",
    });
  });

  it("returns null for non-tui keys and multi-segment session keys", () => {
    expect(parseTuiSessionKey("agent:main:main")).toBeNull();
    expect(parseTuiSessionKey("agent:main:webchat:tab-a")).toBeNull();
    expect(parseTuiSessionKey("agent:worker:subagent:123")).toBeNull();
  });
});
