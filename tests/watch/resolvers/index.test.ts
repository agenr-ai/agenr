import { describe, expect, it } from "vitest";
import { detectWatchPlatform, getResolver } from "../../../src/watch/resolvers/index.js";

describe("watch resolver registry", () => {
  it("selects explicit resolver by platform", () => {
    const resolver = getResolver("openclaw", "/tmp/.openclaw/agents/main/sessions");
    expect(resolver.filePattern).toBe("*.jsonl");
  });

  it("detects resolver from path conventions", () => {
    expect(detectWatchPlatform(undefined, "/Users/jim/.openclaw/agents/main/sessions")).toBe("openclaw");
    expect(detectWatchPlatform(undefined, "/Users/jim/.claude/projects/abc")).toBe("claude-code");
    expect(detectWatchPlatform(undefined, "/Users/jim/.codex/sessions")).toBe("codex");
    expect(detectWatchPlatform(undefined, "/tmp/random/sessions")).toBe("mtime");
  });

  it("throws on unsupported explicit platform", () => {
    expect(() => getResolver("unknown", "/tmp/sessions")).toThrow("Unsupported platform");
  });
});
