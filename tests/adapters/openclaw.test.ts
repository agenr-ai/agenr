import path from "node:path";
import { describe, expect, it } from "vitest";
import { openClawAdapter } from "../../src/adapters/openclaw.js";

describe("openclaw adapter", () => {
  it("extracts messages and timestamps from OpenClaw JSONL", async () => {
    const fixture = path.resolve("tests/fixtures/sample-transcript.jsonl");
    const parsed = await openClawAdapter.parse(fixture);

    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(parsed.messages[0]?.timestamp).toBe("2026-02-14T00:00:01.000Z");
    expect(parsed.messages[2]?.timestamp).toBe("2026-02-14T00:00:04.000Z");
    expect(parsed.metadata?.platform).toBe("openclaw");
    expect(parsed.metadata?.startedAt).toBe("2026-02-14T00:00:00.000Z");
    expect(parsed.warnings.some((warning) => warning.includes("Skipped malformed JSONL line"))).toBe(true);
  });
});
