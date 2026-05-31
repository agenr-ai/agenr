import { describe, expect, it } from "vitest";

import { buildSkelnSubagentCommandNote } from "../../../../src/adapters/skeln/hooks/subagent-findings.js";

describe("buildSkelnSubagentCommandNote", () => {
  it("builds a bounded command note from successful subagent details", () => {
    const note = buildSkelnSubagentCommandNote(
      {
        toolName: "subagent",
        isError: false,
        details: {
          mode: "parallel",
          artifactPath: "/tmp/session/artifacts/subagent/runs-1.json",
          results: [
            {
              agent: "scout",
              name: "api-review",
              status: "completed",
              stdout: "Found the shutdown hook in src/adapters/skeln/index.ts.\nMore detail.",
              stderr: "",
            },
            {
              agent: "reviewer",
              status: "failed",
              stdout: "",
              stderr: "Typecheck failed in episode-writer.ts.",
            },
          ],
        },
      },
      "2026-05-30T00:00:00.000Z",
    );

    expect(note).toEqual({
      command: "subagent parallel",
      observedAt: "2026-05-30T00:00:00.000Z",
      outcome: [
        "mode=parallel",
        "- scout/api-review: completed - Found the shutdown hook in src/adapters/skeln/index.ts.",
        "- reviewer: failed - Typecheck failed in episode-writer.ts.",
        "artifact=/tmp/session/artifacts/subagent/runs-1.json",
      ].join("\n"),
    });
  });

  it("ignores non-subagent and error results", () => {
    expect(buildSkelnSubagentCommandNote({ toolName: "shell", isError: false, details: {} }, "2026-05-30T00:00:00.000Z")).toBeUndefined();
    expect(buildSkelnSubagentCommandNote({ toolName: "subagent", isError: true, details: {} }, "2026-05-30T00:00:00.000Z")).toBeUndefined();
  });
});
