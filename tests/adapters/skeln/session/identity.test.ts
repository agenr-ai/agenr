import { describe, expect, it } from "vitest";

import { resolveSessionIdentityKey, resolveSkelnSessionKey } from "../../../../src/adapters/skeln/session/identity.js";

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

describe("resolveSessionIdentityKey", () => {
  it("prefers session ids over session keys", () => {
    expect(resolveSessionIdentityKey("session-1", "skeln:session:session-1:cwd:/tmp/project")).toBe("session:session-1");
  });

  it("falls back to session keys when session ids are absent", () => {
    expect(resolveSessionIdentityKey(undefined, "skeln:session:session-1:cwd:/tmp/project")).toBe("key:skeln:session:session-1:cwd:/tmp/project");
  });

  it("returns undefined when no identity is available", () => {
    expect(resolveSessionIdentityKey(undefined, undefined)).toBeUndefined();
  });
});
