import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createClient, type Client } from "@libsql/client";

import { setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import {
  deleteAppCredential,
  hasAppCredential,
  listAppCredentials,
  retrieveAppCredential,
  storeAppCredential,
} from "../../src/vault/app-credential-store";

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

describe("app credential store", () => {
  test("stores and retrieves app oauth credentials", async () => {
    await storeAppCredential("stripe", {
      clientId: "ca_test_123",
      clientSecret: "sk_test_123",
    });

    const credential = await retrieveAppCredential("stripe");
    expect(credential).toEqual({
      clientId: "ca_test_123",
      clientSecret: "sk_test_123",
    });
  });

  test("list returns configured service metadata without secrets", async () => {
    await storeAppCredential("stripe", {
      clientId: "ca_test_123",
      clientSecret: "sk_test_123",
    });
    await storeAppCredential("square", {
      clientId: "sq0idp-app",
      clientSecret: "square-secret",
    });

    const listed = await listAppCredentials();
    expect(listed).toHaveLength(2);
    expect(listed.map((entry) => entry.service)).toEqual(["square", "stripe"]);
    expect(listed[0]).not.toHaveProperty("clientId");
    expect(listed[0]).not.toHaveProperty("clientSecret");
  });

  test("delete removes configured credential", async () => {
    await storeAppCredential("stripe", {
      clientId: "ca_test_123",
      clientSecret: "sk_test_123",
    });
    expect(await hasAppCredential("stripe")).toBe(true);

    await deleteAppCredential("stripe");
    expect(await hasAppCredential("stripe")).toBe(false);
  });

  test("retrieve throws for missing service", async () => {
    await expect(retrieveAppCredential("stripe")).rejects.toThrow("Credential not found for service 'stripe'.");
  });
});

