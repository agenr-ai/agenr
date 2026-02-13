import type { AgpAdapter } from "../adapters/adapter";
import { AdapterContext, type AdapterContextOptions, type AuthCredential } from "../adapters/context";
import type { AdapterManifest } from "../adapters/manifest";
import { AdapterRegistry } from "./adapter-registry";
import { InteractionProfileStore } from "../store/interaction-profile-store";
import { ProfileStore } from "../store/profile-store";
import { TransactionStore } from "../store/transaction-store";
import { getBusinessById } from "../db/businesses";
import type { DiscoverRequestBody, ExecuteRequestBody, QueryRequestBody } from "../types/agp";
import type { BusinessProfile } from "../types/profile";
import { retrieveCredential } from "../vault/credential-store";
import { logCredentialRetrieved } from "../vault/audit";
import { refreshIfNeeded, type OAuthRefreshConfig } from "../vault/token-refresh";

const CREDENTIAL_NOT_FOUND_MESSAGE = "Credential not found";
const DEFAULT_ADAPTER_TIMEOUT_MS = 30_000;
const MAX_ADAPTER_ERROR_MESSAGE_LENGTH = 500;

interface ResolvedBusiness {
  business: BusinessProfile;
  credentialOwnerId?: string;
}

function parsePositiveInteger(rawValue: string | undefined, fallback: number): number {
  if (!rawValue?.trim()) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "AbortError" || error.name === "TimeoutError";
}

function resolveCredentialService(manifest: AdapterManifest, platform: string): string {
  if (manifest.auth.type !== "oauth2") {
    return platform;
  }

  const oauthService = manifest.auth.oauth?.oauthService?.trim().toLowerCase();
  return oauthService || platform;
}

function resolveRefreshConfig(manifest: AdapterManifest): OAuthRefreshConfig | null {
  if (manifest.auth.type !== "oauth2" || !manifest.auth.oauth) {
    return null;
  }

  return {
    tokenUrl: manifest.auth.oauth.tokenUrl,
    tokenContentType: manifest.auth.oauth.tokenContentType,
  };
}

export class AdapterExecutionTimeoutError extends Error {
  constructor(message = "Adapter execution timed out") {
    super(message);
    this.name = "AdapterExecutionTimeoutError";
  }
}

export class AdapterOperationError extends Error {
  constructor(message = "Adapter operation failed") {
    super(message);
    this.name = "AdapterOperationError";
  }
}

export class AgpService {
  private readonly adapterTimeoutMs: number;

  constructor(
    private readonly profileStore: ProfileStore,
    private readonly interactionProfileStore: InteractionProfileStore,
    private readonly transactionStore: TransactionStore,
    private readonly adapterRegistry: AdapterRegistry,
  ) {
    this.adapterTimeoutMs = parsePositiveInteger(
      process.env.AGENR_ADAPTER_TIMEOUT_MS,
      DEFAULT_ADAPTER_TIMEOUT_MS,
    );
  }

  async discover(input: DiscoverRequestBody, callerId?: string) {
    const ownerKeyId = this.resolveOwnerKeyId(callerId);
    const transaction = await this.transactionStore.create("discover", input.businessId, input, ownerKeyId);

    try {
      const resolvedBusiness = await this.requireBusiness(input.businessId, ownerKeyId);
      const business = resolvedBusiness.business;
      const interactionProfile = this.getInteractionProfile(business.platform);
      const timeoutSignal = AbortSignal.timeout(this.adapterTimeoutMs);
      const { adapter, ctx } = this.createAdapterForBusiness(
        business,
        ownerKeyId,
        resolvedBusiness.credentialOwnerId,
        timeoutSignal,
      );
      const adapterResult = await this.invokeAdapterOperation(
        () => adapter.discover(ctx),
        timeoutSignal,
      );

      const result = {
        business: {
          id: business.id,
          name: business.name,
          platform: business.platform,
          location: business.location,
        },
        preferences: business.preferences,
        ...(interactionProfile ? { capabilities: interactionProfile.capabilities } : {}),
        ...(typeof adapterResult === "object" && adapterResult !== null ? adapterResult as Record<string, unknown> : {}),
      };

      await this.transactionStore.update(transaction.id, "succeeded", { result });

      return {
        transactionId: transaction.id,
        status: "succeeded" as const,
        data: result,
      };
    } catch (error) {
      const message =
        error instanceof AdapterExecutionTimeoutError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Unknown discover error";
      await this.transactionStore.update(transaction.id, "failed", { error: message });
      throw error;
    }
  }

  async query(input: QueryRequestBody, callerId?: string) {
    const ownerKeyId = this.resolveOwnerKeyId(callerId);
    const transaction = await this.transactionStore.create("query", input.businessId, input, ownerKeyId);

    try {
      const resolvedBusiness = await this.requireBusiness(input.businessId, ownerKeyId);
      const business = resolvedBusiness.business;
      this.getInteractionProfile(business.platform);

      const timeoutSignal = AbortSignal.timeout(this.adapterTimeoutMs);
      const { adapter, ctx } = this.createAdapterForBusiness(
        business,
        ownerKeyId,
        resolvedBusiness.credentialOwnerId,
        timeoutSignal,
      );

      const adapterResult = await this.invokeAdapterOperation(
        () => adapter.query(input.request, ctx),
        timeoutSignal,
      );
      await this.transactionStore.update(transaction.id, "succeeded", { result: adapterResult });

      return {
        transactionId: transaction.id,
        status: "succeeded" as const,
        data: adapterResult,
      };
    } catch (error) {
      const message =
        error instanceof AdapterExecutionTimeoutError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Unknown query error";
      await this.transactionStore.update(transaction.id, "failed", { error: message });
      throw error;
    }
  }

  async execute(input: ExecuteRequestBody, callerId?: string) {
    const ownerKeyId = this.resolveOwnerKeyId(callerId);
    const transaction = await this.transactionStore.create("execute", input.businessId, input, ownerKeyId);

    try {
      const resolvedBusiness = await this.requireBusiness(input.businessId, ownerKeyId);
      const business = resolvedBusiness.business;
      this.getInteractionProfile(business.platform);

      const timeoutSignal = AbortSignal.timeout(this.adapterTimeoutMs);
      const { adapter, ctx } = this.createAdapterForBusiness(
        business,
        ownerKeyId,
        resolvedBusiness.credentialOwnerId,
        timeoutSignal,
      );

      const adapterResult = await this.invokeAdapterOperation(
        () =>
          adapter.execute(
            input.request,
            {
              idempotencyKey: input.request.idempotencyKey,
            },
            ctx,
          ),
        timeoutSignal,
      );
      await this.transactionStore.update(transaction.id, "succeeded", { result: adapterResult });

      return {
        transactionId: transaction.id,
        status: "succeeded" as const,
        data: adapterResult,
      };
    } catch (error) {
      const message =
        error instanceof AdapterExecutionTimeoutError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Unknown execute error";
      await this.transactionStore.update(transaction.id, "failed", { error: message });
      throw error;
    }
  }

  async status(transactionId: string, callerId?: string) {
    return await this.transactionStore.get(transactionId, this.resolveOwnerKeyId(callerId));
  }

  // --- Shared helpers ---

  private async requireBusiness(businessId: string, callerId?: string): Promise<ResolvedBusiness> {
    const databaseBusiness = await getBusinessById(businessId);
    if (databaseBusiness?.status === "active") {
      return {
        business: {
          id: databaseBusiness.id,
          name: databaseBusiness.name,
          platform: databaseBusiness.platform,
          ...(databaseBusiness.location ? { location: databaseBusiness.location } : {}),
          ...(databaseBusiness.preferences ? { preferences: databaseBusiness.preferences } : {}),
        },
        credentialOwnerId: databaseBusiness.ownerId,
      };
    }

    const business = this.profileStore.getBusinessProfile(businessId);
    if (business) {
      return { business };
    }

    // Fall back to adapter registry for dynamically generated adapters
    const entry = this.adapterRegistry.resolveEntry(businessId, callerId);
    if (entry) {
      return {
        business: {
          id: businessId,
          name: typeof entry.meta?.name === "string" ? entry.meta.name : businessId,
          platform: entry.platform,
        },
      };
    }

    throw new Error(`Unknown business '${businessId}'`);
  }

  private getInteractionProfile(platform: string) {
    return this.interactionProfileStore.getByPlatform(platform) ?? null;
  }

  private createAdapterForBusiness(
    business: BusinessProfile,
    callerId?: string,
    credentialOwnerId?: string,
    abortSignal?: AbortSignal,
  ): { adapter: AgpAdapter; ctx: AdapterContext } {
    const entry = this.adapterRegistry.resolveEntry(business.platform, callerId);
    if (!entry) {
      throw new Error(`No adapter registered for platform '${business.platform}'`);
    }

    const userId = callerId?.trim() || "anonymous";
    const credentialUserId = credentialOwnerId?.trim() || userId;
    const executionId = crypto.randomUUID();
    const manifest: AdapterManifest = entry.manifest ?? {
      platform: business.platform,
      auth: {
        type: "none",
        strategy: "none",
      },
      authenticatedDomains: [],
      allowedDomains: [],
    };
    const credentialService = resolveCredentialService(manifest, business.platform);
    const refreshConfig = resolveRefreshConfig(manifest);

    const options: AdapterContextOptions = {
      platform: business.platform,
      userId,
      executionId,
      manifest,
      abortSignal,
      resolveCredential: async (options) => {
        try {
          await refreshIfNeeded(
            credentialUserId,
            credentialService,
            refreshConfig,
            options?.force,
          );
          const payload = await retrieveCredential(credentialUserId, credentialService);
          await logCredentialRetrieved(credentialUserId, credentialService, executionId);
          return this.mapCredentialPayload(payload);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes(CREDENTIAL_NOT_FOUND_MESSAGE)
          ) {
            return null;
          }

          throw error;
        }
      },
    };

    const ctx = new AdapterContext(options);
    return {
      adapter: entry.factory(business, ctx),
      ctx,
    };
  }

  private mapCredentialPayload(payload: {
    access_token?: string;
    api_key?: string;
    username?: string;
    password?: string;
    cookie_value?: string;
    client_id?: string;
    client_secret?: string;
  }): AuthCredential {
    return {
      token: payload.access_token,
      apiKey: payload.api_key,
      username: payload.username,
      password: payload.password,
      cookieValue: payload.cookie_value,
      headerValue: payload.access_token || payload.api_key,
      clientId: payload.client_id,
      clientSecret: payload.client_secret,
    };
  }

  private resolveOwnerKeyId(callerId?: string): string {
    const normalized = callerId?.trim();
    return normalized ? normalized : "admin";
  }

  private async withAdapterTimeout<T>(
    operation: () => Promise<T>,
    timeoutSignal: AbortSignal,
  ): Promise<T> {
    if (timeoutSignal.aborted) {
      throw new AdapterExecutionTimeoutError();
    }

    let abortHandler: (() => void) | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      abortHandler = () => reject(new AdapterExecutionTimeoutError());
      timeoutSignal.addEventListener("abort", abortHandler, { once: true });
    });

    try {
      return await Promise.race([operation(), timeoutPromise]);
    } catch (error) {
      if (timeoutSignal.aborted && isAbortLikeError(error)) {
        throw new AdapterExecutionTimeoutError();
      }
      throw error;
    } finally {
      if (abortHandler) {
        timeoutSignal.removeEventListener("abort", abortHandler);
      }
    }
  }

  private async invokeAdapterOperation<T>(
    operation: () => Promise<T>,
    timeoutSignal: AbortSignal,
  ): Promise<T> {
    try {
      return await this.withAdapterTimeout(operation, timeoutSignal);
    } catch (error) {
      if (error instanceof AdapterExecutionTimeoutError) {
        throw error;
      }

      if (error instanceof Error) {
        throw new AdapterOperationError(this.truncateAdapterErrorMessage(error.message));
      }

      throw new AdapterOperationError();
    }
  }

  private truncateAdapterErrorMessage(message: string): string {
    if (message.length <= MAX_ADAPTER_ERROR_MESSAGE_LENGTH) {
      return message;
    }
    return message.slice(0, MAX_ADAPTER_ERROR_MESSAGE_LENGTH);
  }
}
