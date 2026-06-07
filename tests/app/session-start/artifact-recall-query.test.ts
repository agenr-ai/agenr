import { describe, expect, it } from "vitest";

import { buildSessionStartArtifactRecallQuery } from "../../../src/app/session-start/artifact-recall-query.js";
import type { SessionArtifact } from "../../../src/app/session-memory/types.js";

describe("buildSessionStartArtifactRecallQuery", () => {
  it("builds a bounded query from predecessor session artifacts", () => {
    const query = buildSessionStartArtifactRecallQuery(
      [
        createArtifact({
          id: "episode-1",
          kind: "session_episode",
          summary: "The previous session episode summary.",
        }),
        createArtifact({
          id: "checkpoint-1",
          kind: "compaction_checkpoint",
          summary: "Compacted long debugging thread.",
        }),
      ],
      200,
    );

    expect(query).toBe("Compaction checkpoint: Compacted long debugging thread. Session episode: The previous session episode summary.");
  });

  it("returns undefined when no artifact summaries are available", () => {
    expect(buildSessionStartArtifactRecallQuery([], 200)).toBeUndefined();
  });
});

function createArtifact(overrides: Pick<SessionArtifact, "id" | "kind" | "summary">): SessionArtifact {
  return {
    sessionKey: "parent-session",
    source: "skeln",
    sourceId: overrides.id,
    contentHash: `${overrides.id}-hash`,
    createdAt: "2026-05-30T00:00:00.000Z",
    ...overrides,
  };
}
