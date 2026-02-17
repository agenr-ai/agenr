import { afterEach, describe, expect, it, vi } from "vitest";
import { installSignalHandlers, resetShutdownForTests } from "../src/shutdown.js";

afterEach(() => {
  resetShutdownForTests();
  vi.restoreAllMocks();
});

describe("shutdown", () => {
  it("forces exit on second signal", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as any);

    installSignalHandlers();
    process.emit("SIGINT");

    expect(() => process.emit("SIGINT")).toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

