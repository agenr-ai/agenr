import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";

import {
  countActiveByPlatform,
  getAdapterById,
  getAdapterByPlatformOwner,
  getAdaptersWithSource,
  getPublicAdapterByPlatform,
  listAllAdapters,
  listActiveAdapters,
  listArchivedAdapters,
  listReviewAdapters,
  listVisibleAdapters,
  markAdapterArchived,
  markAdapterPublic,
  markAdapterRejected,
  markAdapterRejectedWithFeedback,
  markAdapterReview,
  markAdapterSandbox,
  upsertSandboxAdapter,
} from "../../src/db/adapters";
import { setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";

let testDb: Client | null = null;
let tempRoot: string;

beforeEach(async () => {
  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
  tempRoot = await mkdtemp(path.join(tmpdir(), "agenr-adapters-db-"));
});

afterEach(async () => {
  if (testDb) {
    await testDb.close();
  }
  await rm(tempRoot, { recursive: true, force: true });
  setDb(null);
  testDb = null;
});

describe("adapters db module", () => {
  test("upsertSandboxAdapter inserts and then updates existing owner/platform row", async () => {
    const first = await upsertSandboxAdapter({
      platform: "Toast",
      ownerId: "owner-1",
      filePath: "/tmp/toast-v1.ts",
    });

    expect(first.platform).toBe("toast");
    expect(first.status).toBe("sandbox");
    expect(first.filePath).toBe("/tmp/toast-v1.ts");

    const second = await upsertSandboxAdapter({
      platform: "toast",
      ownerId: "owner-1",
      filePath: "/tmp/toast-v2.ts",
    });

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("sandbox");
    expect(second.filePath).toBe("/tmp/toast-v2.ts");
  });

  test("unique public-per-platform constraint rejects second public promotion", async () => {
    const ownerA = await upsertSandboxAdapter({
      platform: "stripe",
      ownerId: "owner-a",
      filePath: "/tmp/stripe-owner-a.ts",
    });
    const ownerB = await upsertSandboxAdapter({
      platform: "stripe",
      ownerId: "owner-b",
      filePath: "/tmp/stripe-owner-b.ts",
    });

    await markAdapterPublic({
      adapterId: ownerA.id,
      promotedBy: "admin",
      filePath: "/tmp/stripe-public-a.ts",
    });

    await expect(
      markAdapterPublic({
        adapterId: ownerB.id,
        promotedBy: "admin",
        filePath: "/tmp/stripe-public-b.ts",
      }),
    ).rejects.toThrow();
  });

  test("listVisibleAdapters returns owner sandbox + public only", async () => {
    const ownerSandbox = await upsertSandboxAdapter({
      platform: "toast",
      ownerId: "owner-1",
      filePath: "/tmp/owner-1-toast.ts",
    });
    const otherSandbox = await upsertSandboxAdapter({
      platform: "square",
      ownerId: "owner-2",
      filePath: "/tmp/owner-2-square.ts",
    });
    await markAdapterPublic({
      adapterId: ownerSandbox.id,
      promotedBy: "admin",
      filePath: "/tmp/public-toast.ts",
    });
    await markAdapterRejected({
      adapterId: otherSandbox.id,
      filePath: "/tmp/rejected-square.ts",
    });

    const visible = await listVisibleAdapters("owner-1");
    expect(visible.map((item) => `${item.platform}:${item.status}`)).toEqual(["toast:public"]);
  });

  test("markAdapterSandbox clears promotion metadata", async () => {
    const sandbox = await upsertSandboxAdapter({
      platform: "factor",
      ownerId: "owner-3",
      filePath: "/tmp/factor-sandbox.ts",
    });

    await markAdapterPublic({
      adapterId: sandbox.id,
      promotedBy: "admin",
      filePath: "/tmp/factor-public.ts",
    });

    await markAdapterSandbox({
      adapterId: sandbox.id,
      filePath: "/tmp/factor-sandbox-restored.ts",
    });

    const restored = await getAdapterByPlatformOwner("factor", "owner-3");
    expect(restored?.status).toBe("sandbox");
    expect(restored?.promotedAt).toBeNull();
    expect(restored?.promotedBy).toBeNull();
    expect(restored?.filePath).toBe("/tmp/factor-sandbox-restored.ts");
  });

  test("markAdapterReview sets review status, message, and timestamp", async () => {
    const sandbox = await upsertSandboxAdapter({
      platform: "square",
      ownerId: "owner-review",
      filePath: "/tmp/square-review.ts",
    });

    await markAdapterReview({
      adapterId: sandbox.id,
      reviewMessage: "Please verify refund query flow.",
    });

    const reviewed = await getAdapterById(sandbox.id);
    expect(reviewed?.status).toBe("review");
    expect(reviewed?.reviewMessage).toBe("Please verify refund query flow.");
    expect(reviewed?.submittedAt).not.toBeNull();
    expect(reviewed?.reviewFeedback).toBeNull();
  });

  test("markAdapterRejectedWithFeedback stores feedback and returns adapter to sandbox", async () => {
    const sandbox = await upsertSandboxAdapter({
      platform: "stripe",
      ownerId: "owner-feedback",
      filePath: "/tmp/stripe-feedback.ts",
    });
    await markAdapterReview({
      adapterId: sandbox.id,
      reviewMessage: "v2 candidate",
    });

    await markAdapterRejectedWithFeedback({
      adapterId: sandbox.id,
      feedback: "Use ctx.fetch() for declared domains only.",
    });

    const restored = await getAdapterById(sandbox.id);
    expect(restored?.status).toBe("sandbox");
    expect(restored?.reviewFeedback).toBe("Use ctx.fetch() for declared domains only.");
    expect(restored?.reviewedAt).not.toBeNull();
    expect(restored?.submittedAt).toBeNull();
  });

  test("listReviewAdapters returns only adapters in review status", async () => {
    const reviewA = await upsertSandboxAdapter({
      platform: "toast",
      ownerId: "owner-review-a",
      filePath: "/tmp/toast-review-a.ts",
    });
    const reviewB = await upsertSandboxAdapter({
      platform: "factor75",
      ownerId: "owner-review-b",
      filePath: "/tmp/factor-review-b.ts",
    });
    const sandboxOnly = await upsertSandboxAdapter({
      platform: "square",
      ownerId: "owner-sandbox",
      filePath: "/tmp/square-sandbox.ts",
    });

    await markAdapterReview({ adapterId: reviewA.id, reviewMessage: "A" });
    await markAdapterReview({ adapterId: reviewB.id, reviewMessage: "B" });
    await markAdapterRejected({ adapterId: sandboxOnly.id });

    const reviews = await listReviewAdapters();
    expect(reviews.map((row) => row.id).sort()).toEqual([reviewA.id, reviewB.id].sort());
    expect(reviews.every((row) => row.status === "review")).toBe(true);
  });

  test("round-trip sandbox -> review -> reject -> sandbox preserves review feedback", async () => {
    const sandbox = await upsertSandboxAdapter({
      platform: "mytime",
      ownerId: "owner-round-trip",
      filePath: "/tmp/mytime-round-trip.ts",
    });

    await markAdapterReview({
      adapterId: sandbox.id,
      reviewMessage: "round-trip test",
    });
    await markAdapterRejectedWithFeedback({
      adapterId: sandbox.id,
      feedback: "Missing required auth strategy details.",
    });

    const afterReject = await getAdapterById(sandbox.id);
    expect(afterReject?.status).toBe("sandbox");
    expect(afterReject?.reviewMessage).toBe("round-trip test");
    expect(afterReject?.reviewFeedback).toBe("Missing required auth strategy details.");
    expect(afterReject?.reviewedAt).not.toBeNull();
  });

  test("countActiveByPlatform excludes rejected rows", async () => {
    const sandbox = await upsertSandboxAdapter({
      platform: "mytime",
      ownerId: "owner-4",
      filePath: "/tmp/mytime.ts",
    });

    expect(await countActiveByPlatform("mytime")).toBe(1);

    await markAdapterRejected({
      adapterId: sandbox.id,
      filePath: "/tmp/rejected-mytime.ts",
    });

    expect(await countActiveByPlatform("mytime")).toBe(0);
    expect(await getPublicAdapterByPlatform("mytime")).toBeNull();
    expect((await listActiveAdapters()).length).toBe(0);
  });

  test("markAdapterArchived hides adapter from default lists and tracks archived list", async () => {
    const sandbox = await upsertSandboxAdapter({
      platform: "archive-me",
      ownerId: "owner-archive",
      filePath: "/tmp/archive-me.ts",
    });

    await markAdapterArchived({ adapterId: sandbox.id });

    const updated = await getAdapterById(sandbox.id);
    expect(updated?.status).toBe("archived");
    expect(updated?.archivedAt).not.toBeNull();

    const visible = await listAllAdapters();
    expect(visible.find((row) => row.id === sandbox.id)).toBeUndefined();

    const archived = await listArchivedAdapters();
    expect(archived.some((row) => row.id === sandbox.id)).toBe(true);
  });

  test("upsertSandboxAdapter persists provided sourceCode and sourceHash", async () => {
    const sourceCode = "export default class Adapter {}";
    const expectedHash = createHash("sha256").update(sourceCode).digest("hex");
    const inserted = await upsertSandboxAdapter({
      platform: "Toast",
      ownerId: "owner-source",
      filePath: "/tmp/toast-source.ts",
      sourceCode,
    });

    expect(inserted.sourceCode).toBe(sourceCode);
    expect(inserted.sourceHash).toBe(expectedHash);
  });

  test("upsertSandboxAdapter reads source from file when sourceCode is omitted", async () => {
    const filePath = path.join(tempRoot, "from-file.ts");
    const sourceCode = "export default class FileBackedAdapter {}";
    await writeFile(filePath, sourceCode, "utf8");

    const inserted = await upsertSandboxAdapter({
      platform: "Square",
      ownerId: "owner-file",
      filePath,
    });

    expect(inserted.sourceCode).toBe(sourceCode);
    expect(inserted.sourceHash).toBe(createHash("sha256").update(sourceCode).digest("hex"));
  });

  test("getAdaptersWithSource returns only active adapters with persisted source", async () => {
    const withSource = await upsertSandboxAdapter({
      platform: "stripe",
      ownerId: "owner-with-source",
      filePath: "/tmp/with-source.ts",
      sourceCode: "export default class WithSource {}",
    });
    await upsertSandboxAdapter({
      platform: "square",
      ownerId: "owner-no-source",
      filePath: "/tmp/missing-source.ts",
    });
    const rejected = await upsertSandboxAdapter({
      platform: "toast",
      ownerId: "owner-rejected",
      filePath: "/tmp/rejected-source.ts",
      sourceCode: "export default class Rejected {}",
    });
    await markAdapterRejected({
      adapterId: rejected.id,
      filePath: "/tmp/rejected-source-archived.ts",
    });
    await markAdapterPublic({
      adapterId: withSource.id,
      promotedBy: "admin",
      filePath: "/tmp/with-source-public.ts",
    });

    const sourced = await getAdaptersWithSource();
    expect(sourced.map((row) => row.id)).toEqual([withSource.id]);
    expect(sourced[0]?.sourceCode).toContain("WithSource");
    expect(sourced[0]?.status).toBe("public");
  });
});
