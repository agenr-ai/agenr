import { describe, expect, it } from "vitest";

import { buildDurableTraceTimeline } from "../../../src/app/memory/trace-timeline.js";
import type { Durable } from "../../../src/core/types.js";

describe("buildDurableTraceTimeline", () => {
  it("orders created, dream, profile, and recall events chronologically", () => {
    const entry = createEntry({
      created_at: "2026-06-06T02:00:00.000Z",
      updated_at: "2026-06-06T03:30:00.000Z",
      source_file: "episode:abc",
      supersession_reason: "Dream prune staled a low-signal durable after synthesis.",
      valid_to: "2026-06-06T03:30:00.000Z",
    });

    const timeline = buildDurableTraceTimeline({
      durable: entry,
      dreamActions: [
        {
          id: "action-1",
          runId: "run-1",
          actionType: "insert_durable",
          reasoning: "Inserted durable mined from episode evidence.",
          createdAt: "2026-06-06T02:35:00.000Z",
        },
        {
          id: "action-2",
          runId: "run-2",
          actionType: "stale",
          reasoning: "Dream prune staled a low-signal durable after synthesis.",
          createdAt: "2026-06-06T03:30:00.000Z",
        },
      ],
      recallEvents: [{ recalledAt: "2026-06-06T04:00:00.000Z", query: "duke dog" }],
      profileSnapshots: [
        {
          id: "snapshot-1",
          asOf: "2026-06-06T03:00:00.000Z",
          runId: "run-1",
          createdAt: "2026-06-06T03:00:00.000Z",
          role: "profile",
        },
      ],
    });

    expect(timeline.map((event) => event.kind)).toEqual(["created", "dream", "profile", "updated", "dream", "recall"]);
    expect(timeline[1]?.label).toBe("Dream insert_durable");
    expect(timeline[4]?.actionType).toBe("stale");
  });
});

function createEntry(overrides: Partial<Durable>): Durable {
  return {
    id: "entry-1",
    type: "fact",
    subject: "duke dog details",
    content: "Jim's dog Duke is 12 years old.",
    importance: 4,
    expiry: "permanent",
    tags: [],
    quality_score: 0.5,
    recall_count: 1,
    created_at: "2026-06-06T02:00:00.000Z",
    updated_at: "2026-06-06T02:00:00.000Z",
    ...overrides,
  };
}
