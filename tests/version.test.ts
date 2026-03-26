import { describe, expect, it } from "vitest";

import { APP_VERSION } from "../src/version.js";

describe("APP_VERSION", () => {
  it("is a non-empty string", () => {
    expect(APP_VERSION).toEqual(expect.any(String));
    expect(APP_VERSION.trim()).not.toHaveLength(0);
  });

  it("matches a semver-like version pattern", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });
});
