import { describe, expect, it } from "vitest";

import { renderDurableTraceJson, renderDurableTraceText } from "../../../src/app/memory/render-trace.js";
import type { DurableTrace } from "../../../src/app/memory/ports.js";

describe("renderDurableTrace", () => {
  it("renders provenance, lineage, recall, and timeline sections", () => {
    const trace = createTrace();

    const output = renderDurableTraceText(trace);

    expect(output).toContain("[provenance]");
    expect(output).toContain("source_file=episode:abc");
    expect(output).toContain("[lineage]");
    expect(output).toContain("claim_family=jim/dog");
    expect(output).toContain("[recall] total=3 showing=1");
    expect(output).toContain("[timeline]");
    expect(output).toContain("Dream stale");
  });

  it("renders structured JSON with audit fields", () => {
    const trace = createTrace();
    const payload = JSON.parse(renderDurableTraceJson(trace));

    expect(payload.provenance.sourceFile).toBe("episode:abc");
    expect(payload.recall.totalCount).toBe(3);
    expect(payload.dreamActions).toHaveLength(1);
    expect(payload.timeline).toHaveLength(3);
  });
});

function createTrace(): DurableTrace {
  return {
    durable: {
      id: "entry-1",
      type: "fact",
      subject: "Jim's dog Duke",
      content: "Jim has a dog named Duke.",
      importance: 7,
      expiry: "permanent",
      tags: [],
      quality_score: 0.5,
      recall_count: 3,
      last_recalled_at: "2026-06-06T04:00:00.000Z",
      claim_key: "jim/dog",
      claim_key_status: "trusted",
      source_file: "episode:abc",
      valid_to: "2026-06-06T03:30:00.000Z",
      supersession_kind: "stale",
      supersession_reason: "Dream prune staled a low-signal durable after synthesis.",
      created_at: "2026-06-06T02:00:00.000Z",
      updated_at: "2026-06-06T03:30:00.000Z",
    },
    supersedes: [],
    claimFamily: {
      claimKey: "jim/dog",
      slotPolicy: "exclusive",
      slotPolicyReason: 'Attribute head "dog" defaults to exclusive current-state shaping.',
      durables: [
        {
          id: "entry-1",
          type: "fact",
          subject: "Jim's dog Duke",
          content: "Jim has a dog named Duke.",
          importance: 7,
          expiry: "permanent",
          tags: [],
          quality_score: 0.5,
          recall_count: 3,
          claim_key: "jim/dog",
          claim_key_status: "trusted",
          valid_to: "2026-06-06T03:30:00.000Z",
          created_at: "2026-06-06T02:00:00.000Z",
          updated_at: "2026-06-06T03:30:00.000Z",
        },
      ],
    },
    recall: {
      totalCount: 3,
      recentEvents: [{ recalledAt: "2026-06-06T04:00:00.000Z", query: "duke" }],
    },
    provenance: {
      sourceFile: "episode:abc",
    },
    dreamActions: [
      {
        id: "action-1",
        runId: "run-1",
        actionType: "stale",
        reasoning: "Dream prune staled a low-signal durable after synthesis.",
        createdAt: "2026-06-06T03:30:00.000Z",
      },
    ],
    profileSnapshots: [],
    timeline: [
      {
        at: "2026-06-06T02:00:00.000Z",
        kind: "created",
        label: "Durable created",
      },
      {
        at: "2026-06-06T03:30:00.000Z",
        kind: "dream",
        label: "Dream stale",
        runId: "run-1",
        actionType: "stale",
      },
      {
        at: "2026-06-06T04:00:00.000Z",
        kind: "recall",
        label: "Recalled",
      },
    ],
  };
}
