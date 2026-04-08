import { describe, expect, it } from "vitest";

import { validateEntries } from "../../../src/core/store/validation.js";
import type { StoreEntryInput } from "../../../src/core/types.js";

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
        type: "invalid" as unknown as StoreEntryInput["type"],
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

  it("drops invalid lifecycle boundary values while keeping the normalized claim key", () => {
    const result = validateEntries([
      {
        type: "fact",
        subject: "subject",
        content: "content",
        claim_key: " Jim / Timezone ",
        claim_key_status: "legacy" as StoreEntryInput["claim_key_status"],
        claim_key_source: "handwritten" as StoreEntryInput["claim_key_source"],
        claim_support_mode: "copied" as StoreEntryInput["claim_support_mode"],
        claim_key_confidence: Number.NaN,
      },
    ]);

    expect(result.rejected).toBe(0);
    expect(result.valid[0]).toMatchObject({
      claim_key: "jim/timezone",
      claim_key_status: undefined,
      claim_key_source: undefined,
      claim_support_mode: undefined,
      claim_key_confidence: undefined,
    });
    expect(result.warnings).toEqual([
      expect.stringMatching(/claim_key_status/i),
      expect.stringMatching(/claim_key_source/i),
      expect.stringMatching(/claim_key_confidence/i),
      expect.stringMatching(/claim_support_mode/i),
    ]);
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
        type: "invalid" as unknown as StoreEntryInput["type"],
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
