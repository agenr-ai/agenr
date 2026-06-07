import { describe, expect, it, vi } from "vitest";

import { createSessionLifecycleIntakeTracker } from "../../../src/app/plugin-runtime/session-lifecycle-intake.js";

describe("createSessionLifecycleIntakeTracker", () => {
  it("waits for pending intake recorded for the same session identity", async () => {
    const tracker = createSessionLifecycleIntakeTracker();
    let resolveWork: (() => void) | undefined;
    const work = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });
    const completed = vi.fn();

    void tracker.track("session-1", "agent:main:webchat:test", work).then(completed);
    const wait = tracker.wait("session-1", "agent:main:webchat:test");

    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();

    resolveWork?.();
    await wait;
    expect(completed).toHaveBeenCalledOnce();
  });

  it("does not block unrelated sessions", async () => {
    const tracker = createSessionLifecycleIntakeTracker();
    const pending = new Promise<void>(() => undefined);
    void tracker.track("session-1", "agent:main:webchat:test", pending);

    await expect(tracker.wait("session-2", "agent:main:webchat:test")).resolves.toBeUndefined();
  });

  it("waits for pending intake before clear removes tracked state", async () => {
    const tracker = createSessionLifecycleIntakeTracker();
    let resolveWork: (() => void) | undefined;
    const work = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });
    let cleared = false;

    void tracker.track("session-1", "agent:main:webchat:test", work).finally(() => {
      cleared = true;
    });

    const clearPromise = tracker.clear("session-1", "agent:main:webchat:test");
    await Promise.resolve();
    expect(cleared).toBe(false);

    resolveWork?.();
    await clearPromise;
    expect(cleared).toBe(true);
  });
});
