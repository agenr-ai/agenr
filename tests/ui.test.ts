import { describe, expect, it } from "vitest";

import { APP_VERSION } from "../src/version.js";
import { banner, formatError, formatLabel, formatSuccess, formatWarn } from "../src/ui.js";

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

describe("ui helpers", () => {
  it("includes the current version in the banner", () => {
    expect(stripAnsi(banner())).toContain(APP_VERSION);
  });

  it("includes the agenr name in the banner", () => {
    expect(stripAnsi(banner()).toLowerCase()).toContain("agenr");
  });

  it("formats label-value pairs", () => {
    expect(stripAnsi(formatLabel("Model", "openai/gpt-5.4-mini"))).toBe("Model: openai/gpt-5.4-mini");
  });

  it("formats status helpers as non-empty strings", () => {
    expect(stripAnsi(formatError("failed"))).not.toHaveLength(0);
    expect(stripAnsi(formatWarn("careful"))).not.toHaveLength(0);
    expect(stripAnsi(formatSuccess("done"))).not.toHaveLength(0);
  });
});

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
