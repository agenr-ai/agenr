import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";

import { setDb, getDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { cleanExpiredStates, createState, validateAndConsumeState } from "../../src/connections/oauth-state";

let testDb: Client | null = null;

beforeEach(async () => {
  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
});

afterEach(async () => {
  if (testDb) {
    await testDb.close();
  }
  setDb(null);
  testDb = null;
});

describe("oauth state store", () => {
  test("createState and validateAndConsumeState round-trip", async () => {
    const state = await createState("user-a", "stripe");
    const validated = await validateAndConsumeState(state);

    expect(validated).toEqual({
      userId: "user-a",
      service: "stripe",
      codeVerifier: null,
    });
  });

  test("state is single-use", async () => {
    const state = await createState("user-b", "square");

    expect(await validateAndConsumeState(state)).toEqual({
      userId: "user-b",
      service: "square",
      codeVerifier: null,
    });
    expect(await validateAndConsumeState(state)).toBeNull();
  });

  test("cleanExpiredStates removes states older than 10 minutes", async () => {
    const expiredState = crypto.randomUUID();
    const freshState = crypto.randomUUID();

    await getDb().execute({
      sql: "INSERT INTO oauth_states (state, user_id, service, created_at) VALUES (?, ?, ?, ?)",
      args: [expiredState, "user-expired", "stripe", new Date(Date.now() - 11 * 60 * 1000).toISOString()],
    });
    await getDb().execute({
      sql: "INSERT INTO oauth_states (state, user_id, service, created_at) VALUES (?, ?, ?, ?)",
      args: [freshState, "user-fresh", "stripe", new Date().toISOString()],
    });

    await cleanExpiredStates();

    expect(await validateAndConsumeState(expiredState)).toBeNull();
    expect(await validateAndConsumeState(freshState)).toEqual({
      userId: "user-fresh",
      service: "stripe",
      codeVerifier: null,
    });
  });
});
