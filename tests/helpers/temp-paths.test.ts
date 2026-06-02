import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { isWindowsTestMode } from "./test-platform.js";
import { waitForDatabaseRelease } from "./temp-paths.js";

describe("isWindowsTestMode", () => {
  const original = process.env.AGENR_TEST_WIN;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AGENR_TEST_WIN;
    } else {
      process.env.AGENR_TEST_WIN = original;
    }
  });

  it("is false by default on non-Windows hosts", () => {
    delete process.env.AGENR_TEST_WIN;
    if (process.platform === "win32") {
      expect(isWindowsTestMode()).toBe(true);
      return;
    }

    expect(isWindowsTestMode()).toBe(false);
  });

  it("is true when AGENR_TEST_WIN=1", () => {
    process.env.AGENR_TEST_WIN = "1";
    expect(isWindowsTestMode()).toBe(true);
  });
});

describe("removeTestPath", () => {
  it("retries transient EBUSY unlink failures", async () => {
    vi.resetModules();

    const target = path.join(os.tmpdir(), `agenr-busy-${randomUUID()}.sqlite`);
    let attempts = 0;

    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        rm: vi.fn(async (pathValue, options) => {
          attempts += 1;
          if (attempts < 3) {
            const error = new Error(`EBUSY: ${String(pathValue)}`) as NodeJS.ErrnoException;
            error.code = "EBUSY";
            throw error;
          }

          return actual.rm(pathValue, options);
        }),
      };
    });

    const fsPromises = await import("node:fs/promises");
    await fsPromises.writeFile(target, "locked");
    const { removeTestPath } = await import("./temp-paths.js");

    try {
      await removeTestPath(target);
      expect(attempts).toBe(3);
      await expect(fsPromises.access(target)).rejects.toThrow();
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});

describe("waitForDatabaseRelease", () => {
  const original = process.env.AGENR_TEST_WIN;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AGENR_TEST_WIN;
    } else {
      process.env.AGENR_TEST_WIN = original;
    }
  });

  it("waits when AGENR_TEST_WIN simulates Windows", async () => {
    delete process.env.AGENR_TEST_WIN;
    if (process.platform === "win32") {
      return;
    }

    const started = Date.now();
    await waitForDatabaseRelease();
    expect(Date.now() - started).toBeLessThan(20);

    process.env.AGENR_TEST_WIN = "1";
    const simulatedStart = Date.now();
    await waitForDatabaseRelease();
    expect(Date.now() - simulatedStart).toBeGreaterThanOrEqual(150);
  });
});
