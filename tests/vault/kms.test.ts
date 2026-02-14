import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { decryptDataKey, generateDataKey, isMockKmsEnabled } from "../../src/vault/kms";
import { zeroFill } from "../../src/vault/encryption";

const ORIGINAL_KMS_KEY_ID = process.env.AGENR_KMS_KEY_ID;

beforeEach(() => {
  delete process.env.AGENR_KMS_KEY_ID;
});

afterEach(() => {
  if (ORIGINAL_KMS_KEY_ID) {
    process.env.AGENR_KMS_KEY_ID = ORIGINAL_KMS_KEY_ID;
  } else {
    delete process.env.AGENR_KMS_KEY_ID;
  }
});

describe("vault kms mock mode", () => {
  test("generateDataKey returns plaintext + encrypted", async () => {
    expect(isMockKmsEnabled()).toBe(true);

    const key = await generateDataKey("ignored-in-mock");
    expect(key.plaintext.byteLength).toBe(32);
    expect(key.encrypted.byteLength).toBeGreaterThan(32);
    expect(key.encrypted.equals(key.plaintext)).toBe(false);

    zeroFill(key.plaintext);
  });

  test("decryptDataKey round-trips correctly", async () => {
    const key = await generateDataKey("ignored-in-mock");
    const decrypted = await decryptDataKey(key.encrypted);

    expect(decrypted.equals(key.plaintext)).toBe(true);

    zeroFill(key.plaintext);
    zeroFill(decrypted);
  });

  test("different users get different DEKs", async () => {
    const userA = await generateDataKey("user-a");
    const userB = await generateDataKey("user-b");

    expect(userA.plaintext.equals(userB.plaintext)).toBe(false);
    expect(userA.encrypted.equals(userB.encrypted)).toBe(false);

    zeroFill(userA.plaintext);
    zeroFill(userB.plaintext);
  });
});
