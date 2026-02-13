import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { decryptDataKey } from "./kms";
import type { CredentialPayload, EncryptedBlob } from "./types";

const AES_256_GCM = "aes-256-gcm";
const DEK_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

function assertValidDek(dek: Buffer): void {
  if (dek.byteLength !== DEK_LENGTH_BYTES) {
    throw new Error(`Invalid DEK length: expected ${DEK_LENGTH_BYTES} bytes, received ${dek.byteLength}.`);
  }
}

function parseCredentialPayload(plaintext: Buffer): CredentialPayload {
  const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Credential payload must be a JSON object.");
  }

  return parsed as CredentialPayload;
}

export function zeroFill(buffer: Buffer): void {
  buffer.fill(0);
}

export function encrypt(plaintext: Buffer, dek: Buffer): EncryptedBlob {
  assertValidDek(dek);

  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(AES_256_GCM, dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv,
    ciphertext,
    authTag,
  };
}

export function decrypt(blob: EncryptedBlob, dek: Buffer): Buffer {
  assertValidDek(dek);

  if (blob.iv.byteLength !== IV_LENGTH_BYTES) {
    throw new Error(`Invalid IV length: expected ${IV_LENGTH_BYTES} bytes, received ${blob.iv.byteLength}.`);
  }

  if (blob.authTag.byteLength !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error(
      `Invalid auth tag length: expected ${AUTH_TAG_LENGTH_BYTES} bytes, received ${blob.authTag.byteLength}.`,
    );
  }

  const decipher = createDecipheriv(AES_256_GCM, dek, blob.iv);
  decipher.setAuthTag(blob.authTag);

  return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]);
}

export async function withDecryptedCredential<T>(
  encryptedDek: Buffer,
  encryptedPayload: EncryptedBlob,
  fn: (credential: CredentialPayload) => Promise<T>,
): Promise<T> {
  let decryptedDek: Buffer | null = null;
  let plaintextBuffer: Buffer | null = null;

  try {
    decryptedDek = await decryptDataKey(encryptedDek);
    plaintextBuffer = decrypt(encryptedPayload, decryptedDek);
    const credential = parseCredentialPayload(plaintextBuffer);
    return await fn(credential);
  } finally {
    if (plaintextBuffer) {
      zeroFill(plaintextBuffer);
    }
    if (decryptedDek) {
      zeroFill(decryptedDek);
    }
  }
}
