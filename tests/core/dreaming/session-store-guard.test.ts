import { describe, expect, it } from "vitest";

import { isHostStoreSourceFile, sourceFileMatchesSession } from "../../../src/core/dreaming/session-store-guard.js";

describe("session store guard helpers", () => {
  it("recognizes host store source files", () => {
    expect(isHostStoreSourceFile("skeln-session:skeln:session:abc:cwd:/tmp/project")).toBe(true);
    expect(isHostStoreSourceFile("openclaw-session:agent:main:session:abc")).toBe(true);
    expect(isHostStoreSourceFile("episode-session:abc:ep-1")).toBe(false);
  });

  it("matches source files to session ids", () => {
    expect(sourceFileMatchesSession("skeln-session:skeln:session:abc:cwd:/tmp/project", "abc")).toBe(true);
    expect(sourceFileMatchesSession("episode:ep-1", "abc")).toBe(false);
  });
});
