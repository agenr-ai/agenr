import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  resolveAdaptersBaseDirectory,
  resolvePublicAdapterPath,
  resolveRejectedAdapterPath,
  resolveRuntimeAdaptersDirectory,
  resolveSandboxAdapterPath,
} from "../../src/utils/adapter-paths";

function isWithinBase(base: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return relative !== "" && relative !== "." && !relative.startsWith("..") && !path.isAbsolute(relative);
}

let originalAdaptersDir: string | undefined;
let originalRuntimeDir: string | undefined;
let testAdaptersDir: string;
let testRuntimeDir: string;

beforeEach(async () => {
  originalAdaptersDir = process.env.AGENR_ADAPTERS_DIR;
  originalRuntimeDir = process.env.AGENR_RUNTIME_ADAPTERS_DIR;
  testAdaptersDir = await mkdtemp(path.join(tmpdir(), "agenr-paths-"));
  testRuntimeDir = await mkdtemp(path.join(tmpdir(), "agenr-runtime-"));
  process.env.AGENR_ADAPTERS_DIR = testAdaptersDir;
  process.env.AGENR_RUNTIME_ADAPTERS_DIR = testRuntimeDir;
});

afterEach(async () => {
  if (originalAdaptersDir === undefined) {
    delete process.env.AGENR_ADAPTERS_DIR;
  } else {
    process.env.AGENR_ADAPTERS_DIR = originalAdaptersDir;
  }
  if (originalRuntimeDir === undefined) {
    delete process.env.AGENR_RUNTIME_ADAPTERS_DIR;
  } else {
    process.env.AGENR_RUNTIME_ADAPTERS_DIR = originalRuntimeDir;
  }
  await rm(testAdaptersDir, { recursive: true, force: true });
  await rm(testRuntimeDir, { recursive: true, force: true });
});

describe("adapter path guards", () => {
  test("resolveSandboxAdapterPath rejects traversal-like platform values", () => {
    expect(() => resolveSandboxAdapterPath("owner-1", "../../etc/passwd")).toThrow("traversal tokens");
    expect(() => resolveSandboxAdapterPath("owner-1", "..\\..\\evil")).toThrow("traversal tokens");
    expect(() => resolveSandboxAdapterPath("owner-1", "foo/bar")).toThrow("traversal tokens");
  });

  test("resolvePublicAdapterPath and resolveRejectedAdapterPath stay within runtime base", () => {
    const runtimeBase = resolveRuntimeAdaptersDirectory();
    const publicPath = resolvePublicAdapterPath("toast");
    const rejectedPath = resolveRejectedAdapterPath("toast", "adapter-1");

    expect(isWithinBase(runtimeBase, publicPath)).toBe(true);
    expect(isWithinBase(runtimeBase, rejectedPath)).toBe(true);
  });
});
