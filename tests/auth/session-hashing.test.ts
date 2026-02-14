import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createClient, type Client } from "@libsql/client";

import { setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { createSession, deleteSession, hashToken, validateSession } from "../../src/db/sessions";
import { upsertOAuthUser } from "../../src/db/users";

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

async function createTestUser() {
  return upsertOAuthUser({
    provider: "github",
    providerId: `session-hash-${crypto.randomUUID()}`,
    email: `session-hash-${crypto.randomUUID()}@example.com`,
    name: "Session Hash User",
  });
}

describe("session token hashing", () => {
  test("createSession returns plaintext token distinct from stored session id", async () => {
    const user = await createTestUser();
    const session = await createSession(user.id);

    expect(session.token).not.toBe(session.id);
    expect(session.id).toBe(hashToken(session.token));
  });

  test("validateSession accepts plaintext token", async () => {
    const user = await createTestUser();
    const session = await createSession(user.id);

    const validated = await validateSession(session.token);
    expect(validated).not.toBeNull();
    expect(validated?.id).toBe(session.id);
    expect(validated?.userId).toBe(user.id);
  });

  test("validateSession rejects hashed token", async () => {
    const user = await createTestUser();
    const session = await createSession(user.id);

    const validated = await validateSession(session.id);
    expect(validated).toBeNull();
  });

  test("deleteSession removes session when plaintext token is provided", async () => {
    const user = await createTestUser();
    const session = await createSession(user.id);

    await deleteSession(session.token);
    const validated = await validateSession(session.token);
    expect(validated).toBeNull();
  });

  test("hashToken is deterministic", () => {
    const input = "repeatable-token";

    expect(hashToken(input)).toBe(hashToken(input));
  });

  test("hashToken returns 64-char hex digest", () => {
    const digest = hashToken("token-to-hash");

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
