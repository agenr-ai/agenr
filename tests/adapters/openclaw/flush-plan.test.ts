import { describe, expect, it, vi } from "vitest";

import { buildAgenrMemoryFlushPlan } from "../../../src/adapters/openclaw/memory/flush-plan.js";

describe("buildAgenrMemoryFlushPlan", () => {
  it("returns null and emits the pass-through debug log", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    expect(buildAgenrMemoryFlushPlan({}, logger)).toBeNull();
    expect(logger.debug).toHaveBeenCalledWith("[agenr] flush-plan: pass-through (no custom flush)");
    expect(logger.info).not.toHaveBeenCalled();
  });
});
