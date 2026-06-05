import { type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { createDreamPort } from "../../../src/adapters/db/dreaming-port.js";
import {
  beginEpisodeWrite,
  endEpisodeWrite,
  isEpisodeWriteInProgress,
  releaseDreamingRunLock,
  resetDreamingConcurrencyStateForTests,
  tryAcquireDreamingRunLock,
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
    expect(first.acquired).toBe(true);
    expect(first.token).toBeTruthy();

    const second = await tryAcquireDreamingRunLock(port, ":memory:");
    expect(second.acquired).toBe(false);

    await releaseDreamingRunLock(port, ":memory:", first.token!);

    const third = await tryAcquireDreamingRunLock(port, ":memory:");
    expect(third.acquired).toBe(true);
  });

  it("tracks in-process episode write guards by database path", () => {
    expect(isEpisodeWriteInProgress(":memory:")).toBe(false);
    beginEpisodeWrite(":memory:");
    expect(isEpisodeWriteInProgress(":memory:")).toBe(true);
    endEpisodeWrite(":memory:");
    expect(isEpisodeWriteInProgress(":memory:")).toBe(false);
  });
});
