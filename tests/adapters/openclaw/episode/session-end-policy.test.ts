import { describe, expect, it } from "vitest";

import { isOpenClawSessionEndCompaction } from "../../../../src/adapters/openclaw/episode/session-end-policy.js";

describe("isOpenClawSessionEndCompaction", () => {
  it("returns true only for compaction session-end reasons", () => {
    expect(isOpenClawSessionEndCompaction("compaction")).toBe(true);
    expect(isOpenClawSessionEndCompaction("idle")).toBe(false);
    expect(isOpenClawSessionEndCompaction("reset")).toBe(false);
    expect(isOpenClawSessionEndCompaction(undefined)).toBe(false);
  });
});
