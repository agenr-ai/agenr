import { describe, expect, it } from "vitest";
import { stripPromptMetadata } from "./session-query.js";

describe("stripPromptMetadata", () => {
  it("returns just the user text for a full metadata envelope with timestamp", () => {
    const input = `Conversation info (untrusted metadata):
\`\`\`json
{
  "message_id": "08f2ed82-1111-2222-3333-444455556666",
  "sender_id": "gateway-client",
  "sender": "gateway-client"
}
\`\`\`

[Sun 2026-02-22 21:08 CST] hey`;

    expect(stripPromptMetadata(input)).toBe("hey");
  });

  it("returns trimmed input when there is no envelope", () => {
    expect(stripPromptMetadata("  what should we work on next?  ")).toBe(
      "what should we work on next?",
    );
  });

  it("returns empty string for empty input", () => {
    expect(stripPromptMetadata("")).toBe("");
  });

  it("strips at the last timestamp-like pattern", () => {
    const input =
      "I said [Mon 2026-01-01 09:00 CST] something\n[Tue 2026-01-02 10:00 CST] actual message";

    expect(stripPromptMetadata(input)).toBe("actual message");
  });

  it("returns empty string when timestamp has no trailing content", () => {
    expect(stripPromptMetadata("[Sun 2026-02-22 21:08 CST] ")).toBe("");
  });
});
