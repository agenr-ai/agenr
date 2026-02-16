import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function vector(head: [number, number, number]): number[] {
  const norm = Math.sqrt(head[0] ** 2 + head[1] ** 2 + head[2] ** 2);
  const normalized = head.map((item) => item / norm);
  return [...normalized, ...Array.from({ length: 509 }, () => 0)];
}

describe("consolidate verify", () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];
  const resetModules = () => {
    if (typeof vi.resetModules === "function") {
      vi.resetModules();
    }
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    resetModules();
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  async function loadVerifyModule() {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-verify-home-"));
    tempDirs.push(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    resetModules();
    return import("../src/consolidate/verify.js");
  }

  it("accepts merge when all source and centroid similarity checks pass", async () => {
    const mod = await loadVerifyModule();
    const merged = vector([1, 0, 0]);
    const src1 = vector([0.95, 0.2, 0]);
    const src2 = vector([0.93, 0.22, 0]);

    const result = await mod.verifyMerge("merged", merged, [src1, src2]);
    expect(result.status).toBe("accept");
  });

  it("flags when any source similarity is below 0.65", async () => {
    const mod = await loadVerifyModule();
    const merged = vector([1, 0, 0]);
    const src1 = vector([0.2, 0.98, 0]);
    const src2 = vector([1, 0, 0]);

    const result = await mod.verifyMerge("merged", merged, [src1, src2]);
    expect(result.status).toBe("flag");
    expect(result.reason).toBe("source drift below 0.65");
  });

  it("flags when centroid similarity is below 0.75", async () => {
    const mod = await loadVerifyModule();
    const merged = vector([1, 0, 0]);
    const src1 = vector([0.7, 0.71, 0]);
    const src2 = vector([0.72, 0.69, 0]);

    const result = await mod.verifyMerge("merged", merged, [src1, src2]);
    expect(result.status).toBe("flag");
    expect(result.reason).toBe("centroid drift below 0.75");
  });

  it("appends entries to review queue and reads them back", async () => {
    const mod = await loadVerifyModule();
    await fs.rm(mod.REVIEW_QUEUE_PATH, { force: true });

    await mod.addToReviewQueue({
      mergedContent: "merged one",
      mergedSubject: "subject",
      mergedType: "fact",
      sourceIds: ["a"],
      sourceContents: ["a-content"],
      flagReason: "reason-a",
      flaggedAt: new Date().toISOString(),
    });

    await mod.addToReviewQueue({
      mergedContent: "merged two",
      mergedSubject: "subject",
      mergedType: "fact",
      sourceIds: ["b"],
      sourceContents: ["b-content"],
      flagReason: "reason-b",
      flaggedAt: new Date().toISOString(),
    });

    const queue = await mod.readReviewQueue();
    expect(queue).toHaveLength(2);
    expect(queue[0]?.mergedContent).toBe("merged one");
    expect(queue[1]?.mergedContent).toBe("merged two");
  });

  it("formats flagged merges output", async () => {
    const mod = await loadVerifyModule();
    await fs.rm(mod.REVIEW_QUEUE_PATH, { force: true });

    await mod.addToReviewQueue({
      mergedContent: "merged one",
      mergedSubject: "subject",
      mergedType: "fact",
      sourceIds: ["a", "b"],
      sourceContents: ["a-content", "b-content"],
      flagReason: "reason-a",
      flaggedAt: "2026-02-15T00:00:00.000Z",
    });

    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await mod.showFlaggedMerges();

    const output = writeSpy.mock.calls.map((call) => String(call[0] ?? "")).join("");
    expect(output).toContain("Flagged merges (1)");
    expect(output).toContain("Reason: reason-a");
    expect(output).toContain("Sources: a, b");
  });
});
