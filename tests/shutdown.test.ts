import { afterEach, describe, expect, it, vi } from "vitest";
import { installSignalHandlers, onWake, resetShutdownForTests } from "../src/shutdown.js";

afterEach(() => {
  resetShutdownForTests();
  vi.restoreAllMocks();
});

describe("shutdown", () => {
  it("wakes the watcher immediately on first signal", () => {
    const wakeSpy = vi.fn();

    installSignalHandlers();
    onWake(wakeSpy);

    process.emit("SIGTERM");

    expect(wakeSpy).toHaveBeenCalledTimes(1);
  });

  it("clears wake callback during test reset", () => {
    const wakeSpy = vi.fn();

    installSignalHandlers();
    onWake(wakeSpy);
    resetShutdownForTests();

    installSignalHandlers();
    process.emit("SIGTERM");

    expect(wakeSpy).toHaveBeenCalledTimes(0);
  });

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
