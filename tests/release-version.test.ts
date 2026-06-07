import { describe, expect, it } from "vitest";

import { isReleaseVersion, parseReleaseVersion } from "../src/release-version.js";

describe("parseReleaseVersion", () => {
  it("accepts stable monthly patch versions", () => {
    expect(parseReleaseVersion("2026.6.1")).toEqual({
      version: "2026.6.1",
      baseVersion: "2026.6.1",
      channel: "stable",
      year: 2026,
      month: 6,
      patch: 1,
    });
  });

  it("accepts beta and correction variants", () => {
    expect(parseReleaseVersion("2026.6.2-beta.1")).toEqual({
      version: "2026.6.2-beta.1",
      baseVersion: "2026.6.2",
      channel: "beta",
      year: 2026,
      month: 6,
      patch: 2,
      betaNumber: 1,
    });

    expect(parseReleaseVersion("2026.6.2-1")).toEqual({
      version: "2026.6.2-1",
      baseVersion: "2026.6.2",
      channel: "stable",
      year: 2026,
      month: 6,
      patch: 2,
      correctionNumber: 1,
    });
  });

  it("rejects semver and zero-padded calendar versions", () => {
    expect(parseReleaseVersion("4.0.0")).toBeNull();
    expect(parseReleaseVersion("2026.06.01")).toBeNull();
    expect(parseReleaseVersion("2026.6.0")).toBeNull();
    expect(parseReleaseVersion("")).toBeNull();
  });
});

describe("isReleaseVersion", () => {
  it("mirrors parseReleaseVersion acceptance", () => {
    expect(isReleaseVersion("2026.6.1")).toBe(true);
    expect(isReleaseVersion("1.8.2")).toBe(false);
  });
});
