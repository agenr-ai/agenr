import { describe, expect, it } from "vitest";

import { resolveSkelnSessionKey } from "../../../../src/adapters/skeln/session/scope.js";

describe("resolveSkelnSessionKey", () => {
  it("derives a stable key from session id and cwd", () => {
    expect(resolveSkelnSessionKey("session-1", "/tmp/project")).toBe("skeln:session:session-1:cwd:/tmp/project");
  });

  it("falls back to session id only when cwd is blank", () => {
    expect(resolveSkelnSessionKey("session-1", "   ")).toBe("skeln:session:session-1");
  });

  it("rejects blank session ids", () => {
    expect(() => resolveSkelnSessionKey("   ", "/tmp/project")).toThrow("Skeln session id is required");
  });
});
