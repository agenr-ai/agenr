import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";
import {
  checkAndFlagLowQuality,
  flagForReview,
  getPendingReviews,
  resolveReview,
} from "../../src/db/review-queue.js";

describe("review queue", () => {
  const clients: Client[] = [];

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
  });

  function makeClient(): Client {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    return client;
  }

  async function insertEntry(client: Client, id: string, subject?: string, content?: string): Promise<void> {
    await client.execute({
      sql: `
        INSERT INTO entries (
          id,
          type,
          subject,
          content,
          importance,
          expiry,
          scope,
          source_file,
          source_context,
          created_at,
          updated_at,
          quality_score,
          recall_count
        )
        VALUES (?, 'fact', ?, ?, 5, 'temporary', 'private', 'review-queue.test.jsonl', 'test', ?, ?, 0.5, 0)
      `,
      args: [
        id,
        subject ?? `subject-${id}`,
        content ?? `content-${id}`,
        "2026-02-27T00:00:00.000Z",
        "2026-02-27T00:00:00.000Z",
      ],
    });
  }

  it("creates a pending review item", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "e1");

    const result = await flagForReview(client, "e1", "manual", "needs review", "review");
    expect(result.created).toBe(true);

    const pending = await getPendingReviews(client);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.entryId).toBe("e1");
    expect(pending[0]?.reason).toBe("manual");
  });

  it("skips duplicate pending review for same entry and reason", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "dup");

    await flagForReview(client, "dup", "stale", "first", "review");
    const second = await flagForReview(client, "dup", "stale", "second", "retire");

    expect(second.created).toBe(false);
    const pending = await getPendingReviews(client);
    expect(pending).toHaveLength(1);
  });

  it("allows new pending review after previous one is resolved", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "resolved");

    const first = await flagForReview(client, "resolved", "manual", "first", "review");
    expect(first.id).toBeTruthy();
    const didResolve = await resolveReview(client, first.id ?? "", "resolved");
    expect(didResolve).toBe(true);

    const second = await flagForReview(client, "resolved", "manual", "second", "retire");
    expect(second.created).toBe(true);

    const pending = await getPendingReviews(client);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.detail).toBe("second");
  });

  it("returns pending items ordered by created_at", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "old");
    await insertEntry(client, "new");

    await client.execute({
      sql: `
        INSERT INTO review_queue (id, entry_id, reason, detail, suggested_action, status, created_at)
        VALUES
          ('r-old', 'old', 'manual', 'old item', 'review', 'pending', '2026-02-26T00:00:00.000Z'),
          ('r-new', 'new', 'manual', 'new item', 'review', 'pending', '2026-02-27T00:00:00.000Z')
      `,
      args: [],
    });

    const pending = await getPendingReviews(client);
    expect(pending.map((item) => item.id)).toEqual(["r-old", "r-new"]);
  });

  it("joins entry content in pending review results", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "join", "Join Subject", "Join Content");

    await flagForReview(client, "join", "manual", "detail", "review");
    const pending = await getPendingReviews(client);

    expect(pending[0]?.entrySubject).toBe("Join Subject");
    expect(pending[0]?.entryContent).toBe("Join Content");
  });

  it("resolveReview updates status and resolved_at", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "resolve");

    const review = await flagForReview(client, "resolve", "manual", "detail", "review");
    const updated = await resolveReview(client, review.id ?? "", "dismissed");
    expect(updated).toBe(true);

    const row = await client.execute({
      sql: "SELECT status, resolved_at FROM review_queue WHERE id = ?",
      args: [review.id],
    });
    expect((row.rows[0] as { status?: unknown }).status).toBe("dismissed");
    expect(String((row.rows[0] as { resolved_at?: unknown }).resolved_at ?? "").length).toBeGreaterThan(0);
  });

  it("flags low-quality entries when quality < 0.2 and recall >= 10", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "low-quality");

    await checkAndFlagLowQuality(client, "low-quality", 0.19, 10);

    const pending = await getPendingReviews(client);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.reason).toBe("low_quality");
    expect(pending[0]?.suggestedAction).toBe("retire");
  });

  it("does not flag when quality is >= 0.2", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "quality-ok");

    await checkAndFlagLowQuality(client, "quality-ok", 0.2, 20);

    const pending = await getPendingReviews(client);
    expect(pending).toHaveLength(0);
  });

  it("does not flag when recall count is below 10", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "recall-low");

    await checkAndFlagLowQuality(client, "recall-low", 0.1, 9);

    const pending = await getPendingReviews(client);
    expect(pending).toHaveLength(0);
  });
});
