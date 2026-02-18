import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultPlatformDir } from "../../src/watch/platform-defaults.js";

describe("platform defaults", () => {
  it("returns default directories for supported platforms", () => {
    const home = "/tmp/fake-home";

    expect(getDefaultPlatformDir("openclaw", home)).toBe(
      path.join(home, ".openclaw", "agents", "main", "sessions"),
    );
    expect(getDefaultPlatformDir("codex", home)).toBe(path.join(home, ".codex", "sessions"));
    expect(getDefaultPlatformDir("claude-code", home)).toBe(path.join(home, ".claude", "projects"));
  });

  it("throws for an unsupported platform", () => {
    expect(() => getDefaultPlatformDir("unknown-platform" as never)).toThrow(
      "No default directory for platform: unknown-platform",
    );
  });
});
