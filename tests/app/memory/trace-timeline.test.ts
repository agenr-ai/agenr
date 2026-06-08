import { describe, expect, it } from "vitest";

import { buildDurableTraceTimeline } from "../../../src/app/memory/trace-timeline.js";
import type { Durable } from "../../../src/core/types.js";

describe("buildDurableTraceTimeline", () => {
  it("orders created, dream, profile, and recall events chronologically", () => {
    const entry = createEntry({
      created_at: "2026-06-06T02:00:00.000Z",
      updated_at: "2026-06-06T03:30:00.000Z",
      source_file: "episode:abc",
      superseded_by: "entry-2",
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
    expect(timeline[1]?.label).toBe("Dreaming extracted durable");
    expect(timeline[2]?.label).toBe("Selected for startup memory profile");
    expect(timeline[3]?.label).toBe("Marked superseded");
    expect(timeline[4]?.actionType).toBe("stale");
  });

  it("uses the Dreaming creation action as the creation event for dreamed durables", () => {
    const entry = createEntry({
      created_at: "2026-06-06T02:35:00.000Z",
      updated_at: "2026-06-06T02:35:00.000Z",
      source_file: "episode:abc",
      claim_key_source: "dreaming_extract",
    });

    const timeline = buildDurableTraceTimeline({
      durable: entry,
      dreamActions: [
        {
          id: "action-1",
          runId: "run-1",
          actionType: "insert_durable",
          reasoning: "Inserted durable mined from episode evidence.",
          details: {
            claim_key: "jim/dog",
            evidence_refs: ["episode:abc"],
          },
          createdAt: "2026-06-06T02:35:00.000Z",
        },
      ],
      recallEvents: [],
      profileSnapshots: [],
    });

    expect(timeline.map((event) => event.label)).toEqual(["Dreaming extracted durable"]);
    expect(timeline[0]?.detail).toContain("Inserted durable mined from episode evidence.");
    expect(timeline[0]?.detail).toContain("claim_key=jim/dog");
    expect(timeline[0]?.detail).toContain("evidence=episode:abc");
    expect(timeline[0]?.detail).toContain("run=run-1");
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
