import { describe, expect, it, vi } from "vitest";

import type { SessionArtifact } from "../../../src/app/session-memory/types.js";
import { formatCompactionRecallContext } from "../../../src/adapters/shared/injection/compaction-context.js";
import { resolveCompactionPromptContext } from "../../../src/adapters/shared/compaction-prompt-context.js";
import { createCompactionPromptTracker } from "../../../src/adapters/shared/compaction-prompt-tracker.js";

describe("formatCompactionRecallContext", () => {
  it("formats compaction checkpoint summaries with token metadata", () => {
    const artifact: Pick<SessionArtifact, "summary" | "metadata"> = {
      summary: "Summarized earlier debugging work.",
      metadata: {
        tokensBefore: 12000,
      },
    };

    expect(formatCompactionRecallContext(artifact)).toContain("Summarized earlier debugging work.");
    expect(formatCompactionRecallContext(artifact)).toContain("12,000");
  });
});

describe("resolveCompactionPromptContext", () => {
  it("injects one compaction checkpoint once per artifact source id", async () => {
    const tracker = createCompactionPromptTracker();
    const listSessionArtifacts = vi.fn(async () => [
      {
        id: "artifact-1",
        kind: "compaction_checkpoint" as const,
        sessionKey: "session-1",
        source: "skeln",
        sourceId: "compact-1",
        contentHash: "hash-1",
        summary: "Earlier work was compacted.",
        createdAt: "2026-05-30T00:00:00.000Z",
      },
    ]);

    const first = await resolveCompactionPromptContext({
      sessionId: "session-1",
      sessionKey: "session-1",
      features: { sessionTreeCompaction: true },
      sessionMemoryRepository: { listSessionArtifacts } as never,
      tracker,
    });
    const second = await resolveCompactionPromptContext({
      sessionId: "session-1",
      sessionKey: "session-1",
      features: { sessionTreeCompaction: true },
      sessionMemoryRepository: { listSessionArtifacts } as never,
      tracker,
    });

    expect(first).toContain("Earlier work was compacted.");
    expect(second).toBeUndefined();
    expect(listSessionArtifacts).toHaveBeenCalledTimes(2);
  });
});
