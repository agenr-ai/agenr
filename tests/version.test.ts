import { describe, expect, it } from "vitest";

import { isReleaseVersion } from "../src/release-version.js";
import { APP_VERSION } from "../src/version.js";

describe("APP_VERSION", () => {
  it("is a non-empty string", () => {
    expect(APP_VERSION).toEqual(expect.any(String));
    expect(APP_VERSION.trim()).not.toHaveLength(0);
  });

  it("matches the OpenClaw-style release version format", () => {
    expect(isReleaseVersion(APP_VERSION)).toBe(true);
  });
});
