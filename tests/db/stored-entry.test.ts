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
});
