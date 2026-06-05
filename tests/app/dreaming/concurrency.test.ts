import { type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { createDreamPort } from "../../../src/adapters/db/dreaming-port.js";
import {
  beginEpisodeWrite,
  endEpisodeWrite,
  isEpisodeWriteInProgress,
  resetDreamingConcurrencyStateForTests,
  tryAcquireDreamingRunLock,
  withEpisodeWriteGuard,
} from "../../../src/app/dreaming/concurrency.js";
import { createTestClient } from "../../helpers/dreaming-reconcile.js";

const clients: Client[] = [];

describe("dreaming concurrency", () => {
  afterEach(async () => {
    resetDreamingConcurrencyStateForTests();
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
  });

  it("allows one holder and rejects a second concurrent acquire", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    const first = await tryAcquireDreamingRunLock(port, ":memory:");
    expect(first).toBeTruthy();

    const second = await tryAcquireDreamingRunLock(port, ":memory:");
    expect(second).toBeNull();

    await first!.release();

    const third = await tryAcquireDreamingRunLock(port, ":memory:");
    expect(third).toBeTruthy();
    await third!.release();
  });

  it("tracks in-process episode write guards by database path", () => {
    expect(isEpisodeWriteInProgress(":memory:")).toBe(false);
    beginEpisodeWrite(":memory:");
    expect(isEpisodeWriteInProgress(":memory:")).toBe(true);
    endEpisodeWrite(":memory:");
    expect(isEpisodeWriteInProgress(":memory:")).toBe(false);
  });

  it("holds the dreaming lock while an episode write guard is active", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await withEpisodeWriteGuard({ port, dbPath: ":memory:" }, async () => {
      expect(isEpisodeWriteInProgress(":memory:")).toBe(true);
      expect(await tryAcquireDreamingRunLock(port, ":memory:")).toBeNull();
    });

    expect(isEpisodeWriteInProgress(":memory:")).toBe(false);
    const after = await tryAcquireDreamingRunLock(port, ":memory:");
    expect(after).toBeTruthy();
    await after!.release();
  });
});
