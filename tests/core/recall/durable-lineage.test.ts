import { describe, expect, it } from "vitest";

import { describeDurableLineageState, summarizeClaimFamilyTransition } from "../../../src/core/recall/durable-lineage.js";
import type { Durable } from "../../../src/core/types.js";

const NOW_MS = Date.parse("2026-03-15T00:00:00.000Z");

describe("describeDurableLineageState", () => {
  it("labels open unsuperseded rows as current", () => {
    expect(describeDurableLineageState(baseEntry(), NOW_MS)).toBe("current");
  });

  it("labels superseded rows regardless of validity window", () => {
    expect(describeDurableLineageState({ ...baseEntry(), superseded_by: "successor" }, NOW_MS)).toBe("superseded");
  });

  it("labels closed valid_to rows as historical", () => {
    expect(describeDurableLineageState({ ...baseEntry(), valid_to: "2026-03-15T00:00:00.000Z" }, NOW_MS)).toBe("historical");
  });

  it("keeps future valid_from rows current for trace inspection", () => {
    expect(describeDurableLineageState({ ...baseEntry(), valid_from: "2026-12-01T00:00:00.000Z" }, NOW_MS)).toBe("current");
  });
});

describe("summarizeClaimFamilyTransition", () => {
  it("summarizes a stale prior to current transition", () => {
    const prior = { ...baseEntry(), id: "prior", valid_to: "2026-03-15T00:00:00.000Z" };
    const current = { ...baseEntry(), id: "current" };

    expect(summarizeClaimFamilyTransition([prior, current], NOW_MS)).toBe("prior -> current");
  });

  it("does not treat a scheduled future valid_to row as the prior", () => {
    const scheduled = { ...baseEntry(), id: "scheduled", valid_to: "2026-12-01T00:00:00.000Z" };
    const current = { ...baseEntry(), id: "current" };

    const summary = summarizeClaimFamilyTransition([scheduled, current], NOW_MS);
    expect(summary).not.toContain("->");
  });

  it("prefers the most recent historical sibling as the prior", () => {
    const older = { ...baseEntry(), id: "older", valid_to: "2026-03-01T00:00:00.000Z" };
    const newer = { ...baseEntry(), id: "newer", superseded_by: "current" };
    const current = { ...baseEntry(), id: "current" };

    expect(summarizeClaimFamilyTransition([older, newer, current], NOW_MS)).toBe("newer -> current");
  });
});

function baseEntry(): Durable {
  return {
    id: "entry-1",
    type: "fact",
    subject: "subject",
    content: "content",
    importance: 5,
    expiry: "permanent",
    tags: [],
    quality_score: 0.5,
    recall_count: 0,
    created_at: "2026-03-01T00:00:00.000Z",
    updated_at: "2026-03-01T00:00:00.000Z",
  };
}
