import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, isVerbose, setVerbose } from "../src/logger.js";

describe("logger", () => {
  beforeEach(() => {
    setVerbose(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setVerbose(false);
  });

  it("creates a logger with the expected methods", () => {
    const log = createLogger("extraction");

    expect(log).toEqual({
      info: expect.any(Function),
      warn: expect.any(Function),
      error: expect.any(Function),
      debug: expect.any(Function),
    });
  });

  it("keeps debug silent when verbose logging is disabled", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger("extraction");

    log.debug("hidden");

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("writes debug output when verbose logging is enabled", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const log = createLogger("extraction");

    setVerbose(true);
    log.debug("visible");

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] \[agenr:extraction\] visible\n$/);
  });

  it("includes timestamps and the namespace tag in output", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const log = createLogger("store");

    log.info("processing");
    log.warn("rate limited");
    log.error("failed");

    expect(writes).toHaveLength(3);
    expect(writes[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] \[agenr:store\] processing\n$/);
    expect(writes[1]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] \[agenr:store\] rate limited\n$/);
    expect(writes[2]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] \[agenr:store\] failed\n$/);
  });

  it("round-trips the verbose flag", () => {
    expect(isVerbose()).toBe(false);

    setVerbose(true);
    expect(isVerbose()).toBe(true);

    setVerbose(false);
    expect(isVerbose()).toBe(false);
  });
});
