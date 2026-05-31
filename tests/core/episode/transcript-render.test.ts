import { describe, expect, it } from "vitest";

import {
  MAX_EPISODE_TRANSCRIPT_CHARS,
  MIN_EPISODE_MESSAGES,
  capEpisodeTranscript,
  countMaterialTranscriptTurns,
  renderTranscript,
} from "../../../src/core/episode/transcript-render.js";

describe("episode transcript render helpers", () => {
  it("renders cleaned transcript messages with stable role prefixes", () => {
    expect(
      renderTranscript([
        { role: "user", text: "  Hello there.  " },
        { role: "assistant", text: "Working on it." },
      ]),
    ).toBe("User: Hello there.\nAssistant: Working on it.");
  });

  it("caps long transcripts while preserving the beginning and end", () => {
    const transcript = `User: ${"alpha ".repeat(600)}\nAssistant: ${"omega ".repeat(600)}`;
    const capped = capEpisodeTranscript(transcript, 300);

    expect(capped.length).toBeLessThanOrEqual(300);
    expect(capped).toContain("[Earlier middle transcript omitted for brevity]");
    expect(capped.startsWith("User: alpha")).toBe(true);
    expect(capped).toContain("omega omega");
  });

  it("counts only non-empty transcript messages as material turns", () => {
    expect(countMaterialTranscriptTurns([{ text: "hello" }, { text: "   " }, { text: "world" }])).toBe(2);
  });

  it("exports the shared episode transcript constants", () => {
    expect(MIN_EPISODE_MESSAGES).toBe(4);
    expect(MAX_EPISODE_TRANSCRIPT_CHARS).toBe(14_000);
  });
});
