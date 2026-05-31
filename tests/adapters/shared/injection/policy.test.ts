import { describe, expect, it } from "vitest";

import { isWorkingContextPolicyEnabled, resolveWorkingContextGate } from "../../../../src/adapters/shared/injection/policy.js";

describe("isWorkingContextPolicyEnabled", () => {
  it("defaults to enabled when workingContext is omitted", () => {
    expect(isWorkingContextPolicyEnabled(undefined)).toBe(true);
    expect(isWorkingContextPolicyEnabled({})).toBe(true);
  });

  it("disables injection only when workingContext.enabled is false", () => {
    expect(isWorkingContextPolicyEnabled({ workingContext: { enabled: false } })).toBe(false);
    expect(isWorkingContextPolicyEnabled({ workingContext: { enabled: true } })).toBe(true);
  });
});

describe("resolveWorkingContextGate", () => {
  it("requires workingMemory and policy enabled", () => {
    expect(resolveWorkingContextGate({ workingMemory: false })).toEqual({
      ok: false,
      reason: "features.workingMemory=false",
    });
    expect(resolveWorkingContextGate({ workingMemory: true })).toEqual({ ok: true });
    expect(resolveWorkingContextGate({ workingMemory: true }, { workingContext: { enabled: false } })).toEqual({
      ok: false,
      reason: "memoryPolicy.workingContext.enabled=false",
    });
    expect(resolveWorkingContextGate({ workingMemory: true }, { workingContext: { enabled: true } })).toEqual({ ok: true });
    expect(resolveWorkingContextGate("disabled")).toEqual({
      ok: false,
      reason: "features.workingMemory=false",
    });
    expect(resolveWorkingContextGate("misconfigured")).toEqual({
      ok: false,
      reason: "features.workingMemory enabled without repository",
    });
    expect(resolveWorkingContextGate("enabled")).toEqual({ ok: true });
  });
});
