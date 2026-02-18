import os from "node:os";
import { describe, expect, it } from "vitest";
import { detectProjectFromCwd, normalizeProject } from "../src/project.js";

function makeStat(kind: "file" | "dir"): { isFile(): boolean; isDirectory(): boolean } {
  return {
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
  };
}

describe("project detection", () => {
  it("detectProjectFromCwd returns git root basename when .git directory exists", () => {
    const cwd = "/Users/jim/Code/Agenr";
    const statFn = (p: string) => (p === "/Users/jim/Code/Agenr/.git" ? makeStat("dir") : null);
    expect(detectProjectFromCwd(cwd, statFn)).toBe("agenr");
  });

  it("detectProjectFromCwd walks up from subdir to git root", () => {
    const cwd = "/Users/jim/Code/agenr/src";
    const statFn = (p: string) => (p === "/Users/jim/Code/agenr/.git" ? makeStat("file") : null);
    expect(detectProjectFromCwd(cwd, statFn)).toBe("agenr");
  });

  it("detectProjectFromCwd returns null for home directory", () => {
    expect(detectProjectFromCwd(os.homedir(), () => null)).toBe(null);
  });

  it("detectProjectFromCwd returns null when no git root is found", () => {
    expect(detectProjectFromCwd("/tmp/MyProject", () => null)).toBe(null);
  });

  it("normalizeProject trims and lowercases (and returns null for empty)", () => {
    expect(normalizeProject("  Agenr  ")).toBe("agenr");
    expect(normalizeProject("")).toBe(null);
    expect(normalizeProject("   ")).toBe(null);
  });
});
