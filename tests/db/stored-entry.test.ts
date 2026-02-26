import { describe, expect, it } from "vitest";
import { mapRawStoredEntry } from "../../src/db/stored-entry.js";

function makeRow(recallIntervals: unknown): Record<string, unknown> {
  return {
    id: "entry-1",
    type: "fact",
    subject: "Subject",
    content: "Content",
    importance: 7,
    expiry: "temporary",
    scope: "private",
    source_file: "stored-entry.test",
    source_context: "test",
    created_at: "2026-02-01T00:00:00.000Z",
    updated_at: "2026-02-01T00:00:00.000Z",
    recall_count: 0,
    confirmations: 0,
    contradictions: 0,
    recall_intervals: recallIntervals,
  };
}

describe("mapRawStoredEntry", () => {
  it("returns undefined recallIntervals for non-array JSON payloads", () => {
    const nonArrayPayloads = [JSON.stringify({ value: 1 }), "123", JSON.stringify("text")];

    for (const payload of nonArrayPayloads) {
      const entry = mapRawStoredEntry(makeRow(payload), { tags: [] });
      expect(entry.recall_intervals).toBeUndefined();
    }
  });

  it("filters mixed recallIntervals arrays to numeric values only", () => {
    const entry = mapRawStoredEntry(
      makeRow(JSON.stringify([1708300000, "foo", null])),
      { tags: [] },
    );
    expect(entry.recall_intervals).toEqual([1708300000]);
  });

  it("preserves empty recallIntervals arrays", () => {
    const entry = mapRawStoredEntry(makeRow(JSON.stringify([])), { tags: [] });
    expect(entry.recall_intervals).toEqual([]);
  });

  it("maps structured claim and subject fields", () => {
    const entry = mapRawStoredEntry(
      {
        ...makeRow(undefined),
        subject_entity: "  acme-inc  ",
        subject_attribute: "  ceo  ",
        subject_key: "  acme-inc::ceo  ",
        claim_predicate: "  is  ",
        claim_object: "  jane-doe  ",
        claim_confidence: "0.75",
      },
      { tags: [] },
    );
    expect(entry.subjectEntity).toBe("acme-inc");
    expect(entry.subjectAttribute).toBe("ceo");
    expect(entry.subjectKey).toBe("acme-inc::ceo");
    expect(entry.claimPredicate).toBe("is");
    expect(entry.claimObject).toBe("jane-doe");
    expect(entry.claimConfidence).toBe(0.75);
  });
});
