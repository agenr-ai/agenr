import { describe, expect, it } from "vitest";

import {
  isRecord,
  parseOptionalBoolean,
  parseOptionalIntegerInRange,
  parseOptionalTimestampString,
  parseOptionalTrimmedString,
  parseRequiredTrimmedString,
  pushUnexpectedFields,
  type ValidationIssue,
} from "../../../src/adapters/shared/validation.js";

describe("adapter shared validation helpers", () => {
  it("detects plain object records", () => {
    expect(isRecord({ key: "value" })).toBe(true);
    expect(isRecord(Object.create(null) as Record<string, unknown>)).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(["value"])).toBe(false);
    expect(isRecord("value")).toBe(false);
  });

  it("parses required trimmed strings", () => {
    const issues: ValidationIssue[] = [];

    expect(parseRequiredTrimmedString("  example  ", "field", issues)).toBe("example");
    expect(issues).toEqual([]);
  });

  it("reports invalid required trimmed strings", () => {
    const issues: ValidationIssue[] = [];

    expect(parseRequiredTrimmedString("", "blank", issues)).toBeUndefined();
    expect(parseRequiredTrimmedString(42, "wrongType", issues)).toBeUndefined();
    expect(issues).toEqual([
      {
        path: "blank",
        message: "Expected a non-empty string.",
      },
      {
        path: "wrongType",
        message: "Expected a non-empty string.",
      },
    ]);
  });

  it("parses optional trimmed strings and allows omission", () => {
    const issues: ValidationIssue[] = [];

    expect(parseOptionalTrimmedString(undefined, "missing", issues)).toBeUndefined();
    expect(parseOptionalTrimmedString("  value  ", "field", issues)).toBe("value");
    expect(issues).toEqual([]);
  });

  it("reports invalid optional trimmed strings", () => {
    const issues: ValidationIssue[] = [];

    expect(parseOptionalTrimmedString("   ", "blank", issues)).toBeUndefined();
    expect(parseOptionalTrimmedString(false, "wrongType", issues)).toBeUndefined();
    expect(issues).toEqual([
      {
        path: "blank",
        message: "Expected a non-empty string.",
      },
      {
        path: "wrongType",
        message: "Expected a string.",
      },
    ]);
  });

  it("parses optional booleans", () => {
    const issues: ValidationIssue[] = [];

    expect(parseOptionalBoolean(undefined, "missing", issues)).toBeUndefined();
    expect(parseOptionalBoolean(false, "enabled", issues)).toBe(false);
    expect(issues).toEqual([]);
  });

  it("reports invalid optional booleans", () => {
    const issues: ValidationIssue[] = [];

    expect(parseOptionalBoolean("true", "enabled", issues)).toBeUndefined();
    expect(issues).toEqual([
      {
        path: "enabled",
        message: "Expected a boolean.",
      },
    ]);
  });

  it("parses non-negative and positive integers", () => {
    const issues: ValidationIssue[] = [];

    expect(parseOptionalIntegerInRange(0, "limit", issues, { min: 0 })).toBe(0);
    expect(parseOptionalIntegerInRange(3, "radius", issues, { min: 1 })).toBe(3);
    expect(parseOptionalIntegerInRange(7, "importance", issues, { min: 1, max: 10 })).toBe(7);
    expect(issues).toEqual([]);
  });

  it("reports integers outside the allowed range", () => {
    const issues: ValidationIssue[] = [];

    expect(parseOptionalIntegerInRange(-1, "limit", issues, { min: 0 })).toBeUndefined();
    expect(parseOptionalIntegerInRange(0, "radius", issues, { min: 1 })).toBeUndefined();
    expect(parseOptionalIntegerInRange(11, "importance", issues, { min: 1, max: 10 })).toBeUndefined();
    expect(parseOptionalIntegerInRange(1.5, "count", issues, {})).toBeUndefined();
    expect(issues).toEqual([
      {
        path: "limit",
        message: "Expected a non-negative integer.",
      },
      {
        path: "radius",
        message: "Expected a positive integer.",
      },
      {
        path: "importance",
        message: "Expected an integer from 1 to 10.",
      },
      {
        path: "count",
        message: "Expected an integer.",
      },
    ]);
  });

  it("parses optional timestamp strings", () => {
    const issues: ValidationIssue[] = [];

    expect(parseOptionalTimestampString(" 2026-04-09T12:00:00.000Z ", "created_at", issues)).toBe("2026-04-09T12:00:00.000Z");
    expect(issues).toEqual([]);
  });

  it("reports invalid optional timestamp strings", () => {
    const issues: ValidationIssue[] = [];

    expect(parseOptionalTimestampString("not-a-date", "created_at", issues)).toBeUndefined();
    expect(issues).toEqual([
      {
        path: "created_at",
        message: "Expected a valid timestamp string.",
      },
    ]);
  });

  it("collects unexpected fields at the root and nested paths", () => {
    const issues: ValidationIssue[] = [];

    pushUnexpectedFields(
      {
        allowed: true,
        extraRoot: true,
      },
      new Set(["allowed"]),
      "",
      issues,
    );
    pushUnexpectedFields(
      {
        known: true,
        extraNested: true,
      },
      new Set(["known"]),
      "sandbox",
      issues,
    );

    expect(issues).toEqual([
      {
        path: "extraRoot",
        message: "Unexpected field.",
      },
      {
        path: "sandbox.extraNested",
        message: "Unexpected field.",
      },
    ]);
  });
});
