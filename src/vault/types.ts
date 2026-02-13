export type AuthType = "oauth2" | "api_key" | "cookie" | "basic" | "app_oauth" | "client_credentials";

export interface CredentialPayload {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  client_id?: string;
  client_secret?: string;
  api_key?: string;
  cookie_name?: string;
  cookie_value?: string;
  username?: string;
  password?: string;
}

export interface EncryptedBlob {
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export interface StoredCredential {
  id: string;
  userId: string;
  serviceId: string;
  authType: AuthType;
  scopes: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
