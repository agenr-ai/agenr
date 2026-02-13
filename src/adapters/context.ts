import { logger } from "../utils/logger";
import { DomainNotAllowedError, matchesDomain } from "./domain-allowlist";
import type { AdapterManifest, AuthStrategy } from "./manifest";

export interface AdapterContextOptions {
  platform: string;
  userId: string;
  executionId: string;
  manifest: AdapterManifest;
  abortSignal?: AbortSignal;
  resolveCredential: (options?: { force?: boolean }) => Promise<AuthCredential | null>;
}

export interface AuthCredential {
  token?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  cookieValue?: string;
  headerValue?: string;
  clientId?: string;
  clientSecret?: string;
}

function requireCredentialValue(value: string | undefined, field: string, platform: string): string {
  if (value && value.length > 0) {
    return value;
  }

  throw new Error(`Missing credential field '${field}' for ${platform}`);
}

function mergeAbortSignals(
  requestSignal: AbortSignal | null | undefined,
  contextSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!requestSignal) {
    return contextSignal;
  }

  if (!contextSignal) {
    return requestSignal;
  }

  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([requestSignal, contextSignal]);
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  requestSignal.addEventListener("abort", abort, { once: true });
  contextSignal.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

export class AdapterContext {
  readonly platform: string;
  readonly userId: string;
  readonly executionId: string;

  private credentialPromise: Promise<AuthCredential | null> | null = null;
  private forceNextResolve = false;

  constructor(private readonly options: AdapterContextOptions) {
    this.platform = options.platform;
    this.userId = options.userId;
    this.executionId = options.executionId;
  }

  async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const parsedUrl = this.parseUrl(url);
    const strategy = this.options.manifest.auth.strategy;
    const isAuthenticatedDomain = matchesDomain(
      parsedUrl.hostname,
      this.options.manifest.authenticatedDomains,
    );
    const isAllowedUnauthenticatedDomain = matchesDomain(
      parsedUrl.hostname,
      this.options.manifest.allowedDomains ?? [],
    );

    if (!isAuthenticatedDomain && !isAllowedUnauthenticatedDomain) {
      logger.warn("adapter_context_domain_not_allowed", {
        platform: this.platform,
        userId: this.userId,
        executionId: this.executionId,
        hostname: parsedUrl.hostname,
      });
      throw new DomainNotAllowedError(parsedUrl.hostname, this.platform);
    }

    const headers = new Headers(init?.headers);
    if (isAuthenticatedDomain) {
      await this.injectAuthHeaders(headers, strategy);
    }
    const signal = mergeAbortSignals(init?.signal, this.options.abortSignal);

    const response = await fetch(parsedUrl.toString(), {
      ...init,
      headers,
      signal,
    });

    if (
      !isAuthenticatedDomain ||
      response.status !== 401 ||
      !this.shouldRetryUnauthorized(strategy)
    ) {
      return response;
    }

    logger.warn("adapter_context_401_retry", {
      platform: this.platform,
      userId: this.userId,
      executionId: this.executionId,
      strategy,
      hostname: parsedUrl.hostname,
    });

    this.credentialPromise = null;
    this.forceNextResolve = true;

    try {
      const retryHeaders = new Headers(init?.headers);
      await this.injectAuthHeaders(retryHeaders, strategy);

      return fetch(parsedUrl.toString(), {
        ...init,
        headers: retryHeaders,
        signal,
      });
    } catch (retryError) {
      logger.warn("adapter_context_401_retry_failed", {
        platform: this.platform,
        userId: this.userId,
        executionId: this.executionId,
        error: retryError,
      });
      return response;
    }
  }

  private parseUrl(url: string | URL): URL {
    if (url instanceof URL) {
      return url;
    }

    return new URL(url);
  }

  async getCredential(): Promise<AuthCredential | null> {
    return this.getCredentialInternal();
  }

  private async injectAuthHeaders(headers: Headers, strategy: AuthStrategy): Promise<void> {
    if (strategy === "none" || strategy === "client-credentials") {
      return;
    }

    const credential = await this.getCredentialInternal();
    if (!credential) {
      logger.error("adapter_context_credential_missing", {
        platform: this.platform,
        userId: this.userId,
        executionId: this.executionId,
      });
      throw new Error(`No credential available for ${this.platform}`);
    }

    switch (strategy) {
      case "bearer": {
        const token = requireCredentialValue(credential.token, "token", this.platform);
        headers.set("Authorization", `Bearer ${token}`);
        break;
      }
      case "api-key-header": {
        const headerName = this.options.manifest.auth.headerName ?? "X-Api-Key";
        const apiKey = requireCredentialValue(credential.apiKey, "apiKey", this.platform);
        headers.set(headerName, apiKey);
        break;
      }
      case "basic": {
        const username = requireCredentialValue(credential.username, "username", this.platform);
        const password = requireCredentialValue(credential.password, "password", this.platform);
        const base64 = btoa(`${username}:${password}`);
        headers.set("Authorization", `Basic ${base64}`);
        break;
      }
      case "cookie": {
        const cookieName = requireCredentialValue(
          this.options.manifest.auth.cookieName,
          "cookieName",
          this.platform,
        );
        const cookieValue = requireCredentialValue(credential.cookieValue, "cookieValue", this.platform);
        const existingCookie = headers.get("Cookie");
        const nextCookie = `${cookieName}=${cookieValue}`;
        headers.set("Cookie", existingCookie ? `${existingCookie}; ${nextCookie}` : nextCookie);
        break;
      }
      case "custom": {
        const headerName = requireCredentialValue(
          this.options.manifest.auth.headerName,
          "headerName",
          this.platform,
        );
        const headerValue = requireCredentialValue(
          credential.headerValue,
          "headerValue",
          this.platform,
        );
        headers.set(headerName, headerValue);
        break;
      }
      default: {
        const neverStrategy: never = strategy;
        throw new Error(`Unsupported auth strategy '${neverStrategy}' for ${this.platform}`);
      }
    }
  }

  private async getCredentialInternal(force?: boolean): Promise<AuthCredential | null> {
    if (force) {
      this.forceNextResolve = true;
      this.credentialPromise = null;
    }

    if (!this.credentialPromise) {
      const shouldForceResolve = this.forceNextResolve;
      this.forceNextResolve = false;
      this.credentialPromise = shouldForceResolve
        ? this.options.resolveCredential({ force: true })
        : this.options.resolveCredential();
    }

    return this.credentialPromise;
  }

  private shouldRetryUnauthorized(strategy: AuthStrategy): boolean {
    return strategy !== "none" && strategy !== "client-credentials";
  }
}
