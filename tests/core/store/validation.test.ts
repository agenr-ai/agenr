import { describe, expect, it } from "vitest";

import { validateEntries } from "../../../src/core/store/validation.js";
import type { StoreDurableInput } from "../../../src/core/types.js";

describe("validateEntries", () => {
  it("passes through a valid entry", () => {
    const result = validateEntries([
      {
        type: "decision",
        subject: "  subject  ",
        content: "  content  ",
        importance: 8,
        expiry: "permanent",
        tags: ["arch"],
      },
    ]);

    expect(result.rejected).toBe(0);
    expect(result.valid).toEqual([
      {
        type: "decision",
        subject: "subject",
        content: "content",
        importance: 8,
        expiry: "permanent",
        tags: ["arch"],
        source_file: undefined,
        source_context: undefined,
        user_id: undefined,
        project: undefined,
        created_at: undefined,
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("passes through an optional created_at timestamp", () => {
    const result = validateEntries([
      {
        type: "fact",
        subject: "subject",
        content: "content",
        created_at: " 2026-03-01T10:00:00.000Z ",
      },
    ]);

    expect(result.valid[0]?.created_at).toBe("2026-03-01T10:00:00.000Z");
    expect(result.warnings).toEqual([]);
  });

  it("passes through strictly ordered temporal validity bounds", () => {
    const result = validateEntries([
      {
        type: "fact",
        subject: "subject",
        content: "content",
        valid_from: " 2026-03-01T00:00:00.000Z ",
        valid_to: " 2026-03-31T00:00:00.000Z ",
      },
    ]);

    expect(result.valid[0]).toMatchObject({
      valid_from: "2026-03-01T00:00:00.000Z",
      valid_to: "2026-03-31T00:00:00.000Z",
    });
    expect(result.warnings).toEqual([]);
  });

  it("rejects reversed temporal validity bounds", () => {
    const result = validateEntries([
      {
        type: "fact",
        subject: "subject",
        content: "content",
        valid_from: "2026-04-01T00:00:00.000Z",
        valid_to: "2026-03-01T00:00:00.000Z",
      },
    ]);

    expect(result.rejected).toBe(1);
    expect(result.errors).toEqual(["Entry 0 valid_from must be earlier than valid_to."]);
  });

  it("passes through optional scoping fields", () => {
    const result = validateEntries([
      {
        type: "fact",
        subject: "subject",
        content: "content",
        user_id: " user-1 ",
        project: " alpha ",
      },
    ]);

    expect(result.valid[0]?.user_id).toBe("user-1");
    expect(result.valid[0]?.project).toBe("alpha");
    expect(result.warnings).toEqual([]);
  });

  it("rejects entries with an empty subject", () => {
    const result = validateEntries([
      {
        type: "fact",
        subject: "   ",
        content: "content",
      },
    ]);

    expect(result.rejected).toBe(1);
    expect(result.valid).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects entries with empty content", () => {
    const result = validateEntries([
      {
        type: "fact",
        subject: "subject",
        content: "   ",
      },
    ]);

    expect(result.rejected).toBe(1);
    expect(result.valid).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects entries with an invalid type", () => {
    const result = validateEntries([
      {
        type: "invalid" as unknown as StoreDurableInput["type"],
        subject: "subject",
        content: "content",
      },
    ]);

    expect(result.rejected).toBe(1);
    expect(result.valid).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("clamps importance to the 1-10 range", () => {
    const result = validateEntries([
      {
        type: "fact",
        subject: "high",
        content: "content",
        importance: 99,
      },
      {
        type: "fact",
        subject: "low",
        content: "content",
        importance: -5,
      },
    ]);

    expect(result.valid[0]?.importance).toBe(10);
    expect(result.valid[1]?.importance).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it('defaults expiry to "temporary"', () => {
    const result = validateEntries([
      {
        type: "fact",
        subject: "subject",
        content: "content",
      },
    ]);

    expect(result.valid[0]?.expiry).toBe("temporary");
    expect(result.warnings).toEqual([]);
  });

  it("defaults importance to 7", () => {
    const result = validateEntries([
      {
        type: "fact",
        subject: "subject",
        content: "content",
      },
    ]);

    expect(result.valid[0]?.importance).toBe(7);
    expect(result.warnings).toEqual([]);
  });

  it("normalizes valid claim keys", () => {
    const result = validateEntries([
      {
        type: "fact",
        subject: "subject",
        content: "content",
        claim_key: " Jim / Home City ",
      },
    ]);

    expect(result.valid[0]?.claim_key).toBe("jim/home_city");
    expect(result.warnings).toEqual([]);
  });

  it("drops malformed claim keys without rejecting the entry", () => {
    const result = validateEntries([
      {
        type: "fact",
        subject: "subject",
        content: "content",
        claim_key: "timezone",
      },
    ]);

    expect(result.rejected).toBe(0);
    expect(result.valid[0]?.claim_key).toBeUndefined();
    expect(result.warnings[0]).toMatch(/invalid claim key/i);
  });

  it("rejects partial or invalid lifecycle bundles instead of silently falling back to manual semantics", () => {
    const result = validateEntries([
      {
        type: "fact",
        subject: "subject",
        content: "content",
        claim_key: " Jim / Timezone ",
        claim_key_status: "legacy" as StoreDurableInput["claim_key_status"],
        claim_key_source: "handwritten" as StoreDurableInput["claim_key_source"],
        claim_key_confidence: Number.NaN,
      },
    ]);

    expect(result.rejected).toBe(1);
    expect(result.valid).toEqual([]);
    expect(result.errors).toEqual([
      "Entry 0 provided partial or invalid claim-key lifecycle metadata. Complete bundles require claim_key_status, claim_key_source, claim_key_confidence, and claim_key_rationale.",
    ]);
    expect(result.warnings).toEqual([
      expect.stringMatching(/claim_key_status/i),
      expect.stringMatching(/claim_key_source/i),
      expect.stringMatching(/claim_key_confidence/i),
    ]);
  });

  it("keeps manual claim keys eligible for manual lifecycle fallback when only support metadata is provided", () => {
    const result = validateEntries([
      {
        type: "fact",
        subject: "subject",
        content: "content",
        claim_key: " Jim / Timezone ",
        claim_support_source_kind: "tool_call",
        claim_support_locator: "session.jsonl#entry:1",
        claim_support_observed_at: "2026-03-01T00:00:00.000Z",
        claim_support_mode: "explicit",
      },
    ]);

    expect(result.rejected).toBe(0);
    expect(result.valid[0]).toMatchObject({
      claim_key: "jim/timezone",
      claim_key_status: undefined,
      claim_key_source: undefined,
      claim_key_confidence: undefined,
      claim_key_rationale: undefined,
      claim_support_source_kind: "tool_call",
      claim_support_locator: "session.jsonl#entry:1",
      claim_support_observed_at: "2026-03-01T00:00:00.000Z",
      claim_support_mode: "explicit",
    });
  });

  it("returns correct counts for mixed valid and invalid entries", () => {
    const result = validateEntries([
      {
        type: "fact",
        subject: "valid",
        content: "content",
      },
      {
        type: "fact",
        subject: " ",
        content: "content",
      },
      {
        type: "invalid" as unknown as StoreDurableInput["type"],
        subject: "subject",
        content: "content",
      },
    ]);

    expect(result.valid).toHaveLength(1);
    expect(result.rejected).toBe(2);
    expect(result.errors).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });
});
