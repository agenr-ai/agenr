import { describe, expect, it } from "vitest";

import { normalizeBoundedLimit } from "../../../src/app/working-memory/limits.js";

describe("normalizeBoundedLimit", () => {
  it("uses the fallback for missing or invalid values", () => {
    expect(normalizeBoundedLimit(undefined, 20, 100)).toBe(20);
    expect(normalizeBoundedLimit(0, 20, 100)).toBe(20);
    expect(normalizeBoundedLimit(-1, 20, 100)).toBe(20);
    expect(normalizeBoundedLimit(1.5, 20, 100)).toBe(20);
  });

  it("keeps positive integers within the maximum bound", () => {
    expect(normalizeBoundedLimit(1, 20, 100)).toBe(1);
    expect(normalizeBoundedLimit(100, 20, 100)).toBe(100);
    expect(normalizeBoundedLimit(101, 20, 100)).toBe(100);
  });
});
