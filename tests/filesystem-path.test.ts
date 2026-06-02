import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveConfigFilesystemPath, resolveLocalFilesystemPath, toAbsoluteFileUrl } from "../src/filesystem-path.js";

describe("filesystem path helpers", () => {
  it("turns plain paths with spaces into absolute file URLs", () => {
    const filePath = path.join("relative dir", "knowledge.db");

    expect(toAbsoluteFileUrl(filePath)).toBe(pathToFileURL(path.resolve(filePath)).href);
  });

  it("resolves absolute file URLs into local paths", () => {
    const filePath = path.join(process.cwd(), "relative dir", "knowledge.db");

    expect(resolveLocalFilesystemPath(pathToFileURL(filePath).href)).toBe(filePath);
  });

  it("resolves relative file URLs against the current working directory", () => {
    expect(resolveLocalFilesystemPath("file:relative%20dir/knowledge.db?ignored=true")).toBe(path.resolve("relative dir", "knowledge.db"));
  });

  it("leaves in-memory config targets unchanged when they cannot resolve to disk", () => {
    expect(resolveConfigFilesystemPath("file::memory:")).toBe("file::memory:");
  });
});
