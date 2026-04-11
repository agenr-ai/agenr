import { describe, expect, it } from "vitest";

import { resolveClaimSlotPolicy } from "../../src/core/claim-slot-policy.js";

describe("resolveClaimSlotPolicy", () => {
  it("keeps the default multivalued registry when no override is provided", () => {
    expect(resolveClaimSlotPolicy("workspace/integration_slack")).toMatchObject({
      policy: "multivalued",
    });
  });

  it("applies runtime attribute-head overrides ahead of defaults", () => {
    expect(
      resolveClaimSlotPolicy("workspace/integration_slack", {
        attributeHeads: {
          integration: "exclusive",
        },
      }),
    ).toMatchObject({
      policy: "exclusive",
      reason: 'Attribute head "integration" is configured as exclusive by runtime policy.',
    });
  });
});
