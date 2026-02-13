import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";

import { logger } from "../utils/logger";

const DEK_BYTES = 32;
const MOCK_WRAP_IV_BYTES = 12;
const MOCK_WRAP_TAG_BYTES = 16;
const MOCK_WRAPPED_VERSION = 1;
const MOCK_KMS_KEY_ID = "mock-local-kms-key";
const MOCK_DEV_SECRET = "agenr-local-dev-kms-secret";

let cachedKmsClient: KMSClient | null = null;
let hasLoggedMockMode = false;

export interface GeneratedDataKey {
  plaintext: Buffer;
  encrypted: Buffer;
}

function isMockMode(): boolean {
  return !process.env.AGENR_KMS_KEY_ID;
}

function getConfiguredKmsKeyId(): string {
  return process.env.AGENR_KMS_KEY_ID?.trim() || MOCK_KMS_KEY_ID;
}

function getKmsClient(): KMSClient {
  if (!cachedKmsClient) {
    cachedKmsClient = new KMSClient({});
  }

  return cachedKmsClient;
}

function readBuffer(value: Uint8Array | undefined, fieldName: string): Buffer {
  if (!value || value.byteLength === 0) {
    throw new Error(`KMS response missing ${fieldName}.`);
  }

  return Buffer.from(value);
}

function getMockWrappingKey(): Buffer {
  const secret = process.env.AGENR_KMS_MOCK_SECRET || MOCK_DEV_SECRET;
  return createHash("sha256").update(secret).digest();
}

function maybeLogMockMode(): void {
  if (hasLoggedMockMode) {
    return;
  }

  logger.warn("vault_kms_mock_mode_enabled", {
    keyId: MOCK_KMS_KEY_ID,
  });
  hasLoggedMockMode = true;
}

function wrapWithMockKey(plaintext: Buffer): Buffer {
  const wrappingKey = getMockWrappingKey();

  try {
    const iv = randomBytes(MOCK_WRAP_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([Buffer.from([MOCK_WRAPPED_VERSION]), iv, authTag, ciphertext]);
  } finally {
    wrappingKey.fill(0);
  }
}

function unwrapWithMockKey(encrypted: Buffer): Buffer {
  const minLength = 1 + MOCK_WRAP_IV_BYTES + MOCK_WRAP_TAG_BYTES;
  if (encrypted.byteLength < minLength) {
    throw new Error("Encrypted mock DEK payload is malformed.");
  }

  const version = encrypted[0];
  if (version !== MOCK_WRAPPED_VERSION) {
    throw new Error(`Unsupported mock DEK payload version: ${version}.`);
  }

  const ivStart = 1;
  const tagStart = ivStart + MOCK_WRAP_IV_BYTES;
  const cipherStart = tagStart + MOCK_WRAP_TAG_BYTES;
  const iv = encrypted.subarray(ivStart, tagStart);
  const authTag = encrypted.subarray(tagStart, cipherStart);
  const ciphertext = encrypted.subarray(cipherStart);
  const wrappingKey = getMockWrappingKey();

  try {
    const decipher = createDecipheriv("aes-256-gcm", wrappingKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } finally {
    wrappingKey.fill(0);
  }
}

async function generateMockDataKey(): Promise<GeneratedDataKey> {
  maybeLogMockMode();

  const plaintext = randomBytes(DEK_BYTES);
  const encrypted = wrapWithMockKey(plaintext);

  return {
    plaintext,
    encrypted,
  };
}

async function decryptMockDataKey(encrypted: Buffer): Promise<Buffer> {
  maybeLogMockMode();
  return unwrapWithMockKey(encrypted);
}

export function isMockKmsEnabled(): boolean {
  return isMockMode();
}

export function getVaultKmsKeyId(): string {
  return getConfiguredKmsKeyId();
}

export async function generateDataKey(keyId?: string): Promise<GeneratedDataKey> {
  if (isMockMode()) {
    return generateMockDataKey();
  }

  const kmsKeyId = keyId?.trim() || getConfiguredKmsKeyId();
  if (!kmsKeyId) {
    throw new Error("AGENR_KMS_KEY_ID must be set when using AWS KMS.");
  }

  const response = await getKmsClient().send(
    new GenerateDataKeyCommand({
      KeyId: kmsKeyId,
      KeySpec: "AES_256",
    }),
  );

  return {
    plaintext: readBuffer(response.Plaintext, "Plaintext"),
    encrypted: readBuffer(response.CiphertextBlob, "CiphertextBlob"),
  };
}

export async function decryptDataKey(encrypted: Buffer): Promise<Buffer> {
  if (isMockMode()) {
    return decryptMockDataKey(encrypted);
  }

  const response = await getKmsClient().send(
    new DecryptCommand({
      CiphertextBlob: encrypted,
    }),
  );

  return readBuffer(response.Plaintext, "Plaintext");
}
