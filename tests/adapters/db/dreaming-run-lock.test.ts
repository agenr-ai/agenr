import { type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  DREAMING_RUN_LOCK_STALE_MS,
  heartbeatDreamStateRunLock,
  releaseDreamStateRunLock,
  tryAcquireDreamStateRunLock,
} from "../../../src/adapters/db/dreaming-run-lock.js";
import { createTestClient } from "../../helpers/dreaming-reconcile.js";

const clients: Client[] = [];

describe("dream_state run lock row", () => {
  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
  });

  it("rejects a second acquire while a fresh lock is held", async () => {
    const client = await createTestClient(clients);
    const now = new Date("2026-06-05T12:00:00.000Z");

    expect(await tryAcquireDreamStateRunLock(client, "holder-a", now)).toBe(true);
    expect(await tryAcquireDreamStateRunLock(client, "holder-b", now)).toBe(false);
  });

  it("takes over a lock whose row is older than the stale threshold", async () => {
    const client = await createTestClient(clients);
    const acquiredAt = new Date("2026-06-05T12:00:00.000Z");
    expect(await tryAcquireDreamStateRunLock(client, "crashed-holder", acquiredAt)).toBe(true);

    const beforeStale = new Date(acquiredAt.getTime() + DREAMING_RUN_LOCK_STALE_MS - 1000);
    expect(await tryAcquireDreamStateRunLock(client, "new-holder", beforeStale)).toBe(false);

    const afterStale = new Date(acquiredAt.getTime() + DREAMING_RUN_LOCK_STALE_MS + 1000);
    expect(await tryAcquireDreamStateRunLock(client, "new-holder", afterStale)).toBe(true);
  });

  it("does not take over a long-running lock that keeps heartbeating", async () => {
    const client = await createTestClient(clients);
    const acquiredAt = new Date("2026-06-05T12:00:00.000Z");
    expect(await tryAcquireDreamStateRunLock(client, "active-holder", acquiredAt)).toBe(true);

    const heartbeatAt = new Date(acquiredAt.getTime() + DREAMING_RUN_LOCK_STALE_MS - 1000);
    expect(await heartbeatDreamStateRunLock(client, "active-holder", heartbeatAt)).toBe(true);

    const afterOriginalStale = new Date(acquiredAt.getTime() + DREAMING_RUN_LOCK_STALE_MS + 1000);
    expect(await tryAcquireDreamStateRunLock(client, "new-holder", afterOriginalStale)).toBe(false);
  });

  it("only releases the lock when the holder token still matches", async () => {
    const client = await createTestClient(clients);
    const now = new Date("2026-06-05T12:00:00.000Z");
    expect(await tryAcquireDreamStateRunLock(client, "holder-a", now)).toBe(true);

    await releaseDreamStateRunLock(client, "stale-holder", now);
    expect(await tryAcquireDreamStateRunLock(client, "holder-b", now)).toBe(false);

    await releaseDreamStateRunLock(client, "holder-a", now);
    expect(await tryAcquireDreamStateRunLock(client, "holder-b", now)).toBe(true);
  });
});
