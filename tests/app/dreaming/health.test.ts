import { describe, expect, it } from "vitest";

import { summarizeClaimKeyHealth } from "../../../src/app/dreaming/reconcile/health.js";
import type { Durable } from "../../../src/core/types.js";

function buildDurable(overrides: Partial<Durable> & Pick<Durable, "id" | "type" | "subject" | "content">): Durable {
  return {
    importance: 5,
    expiry: "permanent",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    tags: [],
    retired: false,
    ...overrides,
  };
}

describe("summarizeClaimKeyHealth", () => {
  it("reports durable coverage and missing-key counts for eligible types", () => {
    const durables: Durable[] = [
      buildDurable({
        id: "with-key",
        type: "fact",
        subject: "Timezone",
        content: "Jim's timezone is America/Chicago.",
        claim_key: "jim/timezone",
      }),
      buildDurable({
        id: "missing-key",
        type: "fact",
        subject: "Language",
        content: "Jim prefers TypeScript for backend work.",
      }),
      buildDurable({
        id: "ineligible-missing",
        type: "note",
        subject: "Scratch",
        content: "Temporary scratch note without a claim key.",
      }),
    ];

    const snapshot = summarizeClaimKeyHealth(durables, ["fact"]);

    expect(snapshot.totalDurables).toBe(3);
    expect(snapshot.activeDurables).toBe(3);
    expect(snapshot.coverageCount).toBe(1);
    expect(snapshot.missingCount).toBe(2);
    expect(snapshot.eligibleMissingCount).toBe(1);
  });
});
