import { describe, expect, it } from "vitest";

import { assertKeyedDurableHasLifecycle, hasKeyedDurableLifecycleStatus, resolveKeyedDurableLifecycleStatus } from "../../src/core/keyed-durable-lifecycle.js";

describe("keyed durable lifecycle", () => {
  it("resolves keyed durable lifecycle status and rejects missing lifecycle metadata", () => {
    expect(resolveKeyedDurableLifecycleStatus({ claim_key: undefined })).toBe("no_key");
    expect(
      resolveKeyedDurableLifecycleStatus({
        id: "entry-1",
        claim_key: "jim/timezone",
        claim_key_status: "trusted",
      }),
    ).toBe("trusted");
    expect(() =>
      assertKeyedDurableHasLifecycle({
        id: "entry-1",
        claim_key: "jim/timezone",
        claim_key_status: undefined,
      }),
    ).toThrow(/claim_key_status/i);
  });

  it("narrows keyed durable rows that carry lifecycle status", () => {
    const entry = {
      claim_key: "jim/timezone",
      claim_key_status: "trusted" as const,
    };

    expect(hasKeyedDurableLifecycleStatus(entry)).toBe(true);
    if (hasKeyedDurableLifecycleStatus(entry)) {
      expect(entry.claim_key_status).toBe("trusted");
    }

    expect(hasKeyedDurableLifecycleStatus({ claim_key: "jim/timezone" })).toBe(false);
    expect(hasKeyedDurableLifecycleStatus({ claim_key: undefined })).toBe(false);
  });
});
