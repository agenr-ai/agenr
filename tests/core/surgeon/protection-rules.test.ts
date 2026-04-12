import { describe, expect, it } from "vitest";

import { isProtectedFromRetirement, SURGEON_PERMANENT_ENTRY_DEMOTION_FLOOR } from "../../../src/core/surgeon/domain/protection-rules.js";

describe("isProtectedFromRetirement", () => {
  const config = {
    now: new Date("2026-03-29T12:00:00.000Z"),
    protectRecalledDays: 14,
    protectMinImportance: 9,
  };

  it("protects core entries", () => {
    expect(
      isProtectedFromRetirement(
        {
          expiry: "core",
          importance: 1,
        },
        config,
      ),
    ).toEqual({
      protected: true,
      reason: "Entry expiry is core.",
    });
  });

  it("protects high-importance entries", () => {
    expect(
      isProtectedFromRetirement(
        {
          expiry: "permanent",
          importance: 9,
        },
        config,
      ),
    ).toEqual({
      protected: true,
      reason: "Entry importance is at or above 9.",
    });
  });

  it("protects permanent entries and points surgeon toward bounded demotion", () => {
    expect(
      isProtectedFromRetirement(
        {
          expiry: "permanent",
          importance: 4,
        },
        config,
      ),
    ).toEqual({
      protected: true,
      reason: `Entry expiry is permanent. Use update_entry to demote importance instead, but keep importance at or above ${SURGEON_PERMANENT_ENTRY_DEMOTION_FLOOR}.`,
    });
  });

  it("protects recently recalled entries", () => {
    expect(
      isProtectedFromRetirement(
        {
          expiry: "temporary",
          importance: 4,
          lastRecalledAt: "2026-03-20T12:00:00.000Z",
        },
        config,
      ),
    ).toEqual({
      protected: true,
      reason: "Entry was recalled within the last 14 days.",
    });
  });

  it("does not protect stale low-importance entries", () => {
    expect(
      isProtectedFromRetirement(
        {
          expiry: "temporary",
          importance: 4,
          lastRecalledAt: "2026-03-01T12:00:00.000Z",
        },
        config,
      ),
    ).toEqual({
      protected: false,
    });
  });

  it("does not protect importance values just below the threshold", () => {
    expect(
      isProtectedFromRetirement(
        {
          expiry: "temporary",
          importance: 8,
        },
        config,
      ),
    ).toEqual({
      protected: false,
    });
  });

  it("protects entries recalled exactly at the protection boundary", () => {
    expect(
      isProtectedFromRetirement(
        {
          expiry: "temporary",
          importance: 4,
          lastRecalledAt: "2026-03-15T12:00:00.000Z",
        },
        config,
      ),
    ).toEqual({
      protected: true,
      reason: "Entry was recalled within the last 14 days.",
    });
  });

  it("does not protect null or blank recall timestamps", () => {
    expect(
      isProtectedFromRetirement(
        {
          expiry: "temporary",
          importance: 4,
          lastRecalledAt: null,
        },
        config,
      ),
    ).toEqual({
      protected: false,
    });

    expect(
      isProtectedFromRetirement(
        {
          expiry: "temporary",
          importance: 4,
          lastRecalledAt: "   ",
        },
        config,
      ),
    ).toEqual({
      protected: false,
    });
  });

  it("treats malformed recall timestamps as unprotected instead of throwing", () => {
    expect(
      isProtectedFromRetirement(
        {
          expiry: "temporary",
          importance: 4,
          lastRecalledAt: "not-a-date",
        },
        config,
      ),
    ).toEqual({
      protected: false,
    });
  });
});
