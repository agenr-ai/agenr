import { describe, expect, test } from "vitest";
import { randomBytes } from "node:crypto";

import { decrypt, encrypt, zeroFill } from "../../src/vault/encryption";

describe("vault encryption", () => {
  test("encrypt/decrypt round-trip with random DEK", () => {
    const dek = randomBytes(32);
    const plaintext = Buffer.from("super secret credential payload", "utf8");

    const encrypted = encrypt(plaintext, dek);
    const decrypted = decrypt(encrypted, dek);

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  test("tampered ciphertext fails authentication", () => {
    const dek = randomBytes(32);
    const plaintext = Buffer.from("sensitive payload", "utf8");
    const encrypted = encrypt(plaintext, dek);
    encrypted.ciphertext[0] ^= 0xff;

    expect(() => decrypt(encrypted, dek)).toThrow();
  });

  test("tampered auth tag fails authentication", () => {
    const dek = randomBytes(32);
    const plaintext = Buffer.from("sensitive payload", "utf8");
    const encrypted = encrypt(plaintext, dek);
    encrypted.authTag[0] ^= 0xff;

    expect(() => decrypt(encrypted, dek)).toThrow();
  });

  test("zeroFill overwrites buffer contents", () => {
    const buffer = Buffer.from("do-not-leak", "utf8");
    zeroFill(buffer);

    expect(buffer.equals(Buffer.alloc(buffer.length))).toBe(true);
  });

  test("different IVs produce different ciphertext for same plaintext", () => {
    const dek = randomBytes(32);
    const plaintext = Buffer.from("same payload", "utf8");

    const first = encrypt(plaintext, dek);
    const second = encrypt(plaintext, dek);

    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });
});
