import { describe, expect, it } from "vitest";

import { resolveWorkingContextGate } from "../../../../src/adapters/shared/injection/policy.js";

describe("resolveWorkingContextGate", () => {
  it("requires workingMemory to be enabled and configured", () => {
    expect(resolveWorkingContextGate({ workingMemory: false })).toEqual({
      ok: false,
      reason: "features.workingMemory=false",
    });
    expect(resolveWorkingContextGate({ workingMemory: true })).toEqual({ ok: true });
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
