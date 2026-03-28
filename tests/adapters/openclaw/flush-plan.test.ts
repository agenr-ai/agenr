import { describe, expect, it, vi } from "vitest";

import { buildAgenrMemoryFlushPlan } from "../../../src/adapters/openclaw/memory/flush-plan.js";

describe("buildAgenrMemoryFlushPlan", () => {
  it("returns null and emits the Phase 1 pass-through info log", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    expect(buildAgenrMemoryFlushPlan({}, logger)).toBeNull();
    expect(logger.info).toHaveBeenCalledWith("[agenr] flush-plan: Phase 1 pass-through (no flush)");
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
