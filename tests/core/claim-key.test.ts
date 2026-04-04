import { describe, expect, it } from "vitest";

import { normalizeClaimKey, normalizeClaimKeySegment, validateExtractedClaimKey } from "../../src/core/claim-key.js";

describe("normalizeClaimKeySegment", () => {
  it("normalizes lowercase snake_case segments", () => {
    expect(normalizeClaimKeySegment(" Home City ")).toBe("home_city");
    expect(normalizeClaimKeySegment("max---connections")).toBe("max_connections");
    expect(normalizeClaimKeySegment("___Version!!!")).toBe("version");
  });
});

describe("normalizeClaimKey", () => {
  it("normalizes canonical valid claim keys", () => {
    expect(normalizeClaimKey("Jim / Home City")).toEqual({
      ok: true,
      value: {
        claimKey: "jim/home_city",
        entity: "jim",
        attribute: "home_city",
      },
    });
    expect(normalizeClaimKey("postgres / max connections")).toEqual({
      ok: true,
      value: {
        claimKey: "postgres/max_connections",
        entity: "postgres",
        attribute: "max_connections",
      },
    });
  });

  it("trims whitespace, lowercases, and collapses punctuation", () => {
    expect(normalizeClaimKey("  React Router / Version!!!  ")).toEqual({
      ok: true,
      value: {
        claimKey: "react_router/version",
        entity: "react_router",
        attribute: "version",
      },
    });
  });

  it("rejects missing separators", () => {
    expect(normalizeClaimKey("timezone")).toEqual({
      ok: false,
      reason: "missing_separator",
    });
  });

  it("rejects extra slash segments", () => {
    expect(normalizeClaimKey("jim/timezone/extra")).toEqual({
      ok: false,
      reason: "too_many_segments",
    });
    expect(normalizeClaimKey("///")).toEqual({
      ok: false,
      reason: "too_many_segments",
    });
  });

  it("rejects empty entity or attribute segments", () => {
    expect(normalizeClaimKey("/timezone")).toEqual({
      ok: false,
      reason: "empty_entity",
    });
    expect(normalizeClaimKey("jim/")).toEqual({
      ok: false,
      reason: "empty_attribute",
    });
  });

  it('rejects "unknown/unknown"', () => {
    expect(normalizeClaimKey("unknown/unknown")).toEqual({
      ok: false,
      reason: "unknown_pair",
    });
  });
});

describe("validateExtractedClaimKey", () => {
  it("rejects self-referential entities", () => {
    const normalized = normalizeClaimKey("we/deployment_process");
    if (!normalized.ok) {
      throw new Error("Expected normalized claim key.");
    }

    expect(validateExtractedClaimKey(normalized.value)).toMatchObject({
      ok: false,
      reason: "self_referential_entity",
    });
  });

  it("rejects generic attributes", () => {
    const normalized = normalizeClaimKey("project_x/details");
    if (!normalized.ok) {
      throw new Error("Expected normalized claim key.");
    }

    expect(validateExtractedClaimKey(normalized.value)).toMatchObject({
      ok: false,
      reason: "generic_attribute",
    });
  });

  it("rejects value-shaped attributes", () => {
    const numeric = normalizeClaimKey("router/7");
    const versionLike = normalizeClaimKey("router/v7");
    if (!numeric.ok || !versionLike.ok) {
      throw new Error("Expected normalized claim key.");
    }

    expect(validateExtractedClaimKey(numeric.value)).toMatchObject({
      ok: false,
      reason: "value_shaped_attribute",
    });
    expect(validateExtractedClaimKey(versionLike.value)).toMatchObject({
      ok: false,
      reason: "value_shaped_attribute",
    });
  });

  it("accepts structurally valid non-generic claim keys", () => {
    const normalized = normalizeClaimKey("jim/timezone");
    if (!normalized.ok) {
      throw new Error("Expected normalized claim key.");
    }

    expect(validateExtractedClaimKey(normalized.value)).toEqual({
      ok: true,
      value: {
        claimKey: "jim/timezone",
        entity: "jim",
        attribute: "timezone",
      },
    });
  });
});
