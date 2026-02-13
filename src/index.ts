import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { readFileSync } from "node:fs";

import { AdapterExecutionTimeoutError, AdapterOperationError, AgpService } from "./core/agp-service";
import { AdapterRegistry } from "./core/adapter-registry";
import { apiKeyAuthMiddleware, requireScope } from "./middleware/auth";
import { idempotencyMiddleware } from "./middleware/idempotency";
import { requestLoggerMiddleware } from "./middleware/logger";
import { executePolicyMiddleware, prepareExecuteConfirmation, resolveExecutePolicy } from "./middleware/policy";
import { rateLimitMiddleware, apiKeyRateLimitMiddleware } from "./middleware/rate-limit";
import { requestIdMiddleware } from "./middleware/request-id";
import { createAdapterRoutes } from "./routes/adapters";
import { appCredentialsApp } from "./routes/app-credentials";
import { auditApp } from "./routes/audit";
import { authApp } from "./routes/auth";
import { createKeyRoutes } from "./routes/keys";
import { createConnectRoutes } from "./routes/connect";
import { credentialsApp } from "./routes/credentials";
import { createBusinessRoutes } from "./routes/businesses";
import { startGenerationWorker } from "./jobs/generation-worker";
import { recoverStaleJobs } from "./jobs/generation-queue";
import { getBaseUrl } from "./connections/base-url";
import { ProfileStore } from "./store/profile-store";
import { InteractionProfileStore } from "./store/interaction-profile-store";
import { TransactionStore } from "./store/transaction-store";
import { migrate } from "./db/migrate";
import { listAllBusinesses } from "./db/businesses";
import { seedEchoBusiness } from "./db/seed-echo";
import { DEMO_KEY_ID, seedPublicDemoKey } from "./db/seed-demo-key";
import {
  createCorsExposeHeadersMiddleware,
  createCorsMiddleware,
  createPreflightOriginGuard,
  resolveCorsOrigins,
} from "./utils/cors";
import { logger } from "./utils/logger";
import { parseJsonBody } from "./utils/json-body";

const discoverSchema = z.object({
  businessId: z.string().min(1),
});

const querySchema = z.object({
  businessId: z.string().min(1),
  request: z.record(z.string(), z.unknown()),
});

const executeSchema = z.object({
  businessId: z.string().min(1),
  request: z.record(z.string(), z.unknown()),
});

const profilePath = process.env.AGENR_USER_PROFILE_PATH ?? "./data/user-profile.json";
const interactionProfileDirectory = "./data/interaction-profiles";
const appVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;
const DEFAULT_ADAPTER_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const ECHO_BUSINESS_ID = "echo";

function parseNonNegativeInteger(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

await migrate();
const recoveredStaleJobs = await recoverStaleJobs();
if (recoveredStaleJobs > 0) {
  logger.info("startup_recovered_stale_generation_jobs", {
    recoveredStaleJobs,
  });
}

const profileStore = new ProfileStore(profilePath);
const interactionProfileStore = new InteractionProfileStore(interactionProfileDirectory);
const transactionStore = new TransactionStore();
const adapterRegistry = new AdapterRegistry();
await adapterRegistry.restoreFromDatabase();
await adapterRegistry.seedBundledAdapters();
await seedEchoBusiness();
await seedPublicDemoKey();
await adapterRegistry.loadDynamicAdapters();
logger.info("startup_adapters_loaded", {
  platforms: adapterRegistry.listPlatforms(),
});
logger.info("startup_profile_store", {
  user: profileStore.getUserProfile().user,
  businessCount: profileStore.getUserProfile().businesses.length,
});
logger.info("startup_interaction_profile_store", {
  platforms: interactionProfileStore.listPlatforms(),
});
if (!process.env.AGENR_BASE_URL?.trim()) {
  logger.warn("startup_base_url_env_missing", {
    env: "AGENR_BASE_URL",
    fallbackBaseUrl: getBaseUrl(),
  });
}
logger.info("startup_base_url", { baseUrl: getBaseUrl() });
startGenerationWorker(adapterRegistry);

const adapterSyncIntervalMs = parseNonNegativeInteger(
  process.env.AGENR_ADAPTER_SYNC_INTERVAL_MS,
  DEFAULT_ADAPTER_SYNC_INTERVAL_MS,
);
if (adapterSyncIntervalMs > 0) {
  setInterval(() => {
    void adapterRegistry.syncFromDatabase().catch((error) => {
      logger.warn("adapter_sync_from_db_failed", { error });
    });
  }, adapterSyncIntervalMs);
} else {
  logger.info("startup_adapter_sync_interval_disabled", {
    env: "AGENR_ADAPTER_SYNC_INTERVAL_MS",
  });
}

const agpService = new AgpService(profileStore, interactionProfileStore, transactionStore, adapterRegistry);
const corsOrigins = resolveCorsOrigins(process.env.AGENR_CORS_ORIGINS);

const app = new Hono();
app.use("*", requestIdMiddleware);
app.use("*", createPreflightOriginGuard(corsOrigins));
app.use("*", createCorsMiddleware(corsOrigins));
app.use("*", createCorsExposeHeadersMiddleware(corsOrigins));
app.use("*", requestLoggerMiddleware);
app.use("*", rateLimitMiddleware);
app.onError((err, c) => {
  const requestId = c.get("requestId") || "unknown";
  console.error(`[${requestId}] Unhandled error:`, err.message);
  return c.json(
    {
      error: "Internal server error",
      message: "An unexpected server error occurred while processing the request.",
      code: "INTERNAL_ERROR",
      requestId,
    },
    500,
  );
});

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    version: appVersion,
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
  });
});

app.get("/agp/businesses", async (c) => {
  const categoryQuery = c.req.query("category")?.trim().toLowerCase();
  const platformQuery = c.req.query("platform")?.trim().toLowerCase();
  const searchQuery = c.req.query("q")?.trim().toLowerCase();

  const businesses = (await listAllBusinesses())
    .filter((business) => business.status === "active")
    .filter((business) => {
      if (categoryQuery && business.category?.toLowerCase() !== categoryQuery) {
        return false;
      }

      if (platformQuery && business.platform.toLowerCase() !== platformQuery) {
        return false;
      }

      if (searchQuery && !business.name.toLowerCase().includes(searchQuery)) {
        return false;
      }

      return true;
    })
    .map((business) => ({
      id: business.id,
      name: business.name,
      platform: business.platform,
      location: business.location,
      category: business.category,
      description: business.description,
    }));

  return c.json({ businesses });
});

app.use("/agp/discover", apiKeyAuthMiddleware);
app.use("/agp/query", apiKeyAuthMiddleware);
app.use("/agp/execute", apiKeyAuthMiddleware);
app.use("/agp/execute/prepare", apiKeyAuthMiddleware);
app.use("/agp/status/*", apiKeyAuthMiddleware);
app.use("/credentials/*", apiKeyAuthMiddleware);
app.use("/app-credentials/*", apiKeyAuthMiddleware);
app.use("/businesses/*", apiKeyAuthMiddleware);
app.use("/audit/*", apiKeyAuthMiddleware);
app.use("/agp/*", apiKeyRateLimitMiddleware);
app.use("/credentials/*", apiKeyRateLimitMiddleware);
app.use("/app-credentials/*", apiKeyRateLimitMiddleware);
app.use("/businesses/*", apiKeyRateLimitMiddleware);
app.use("/audit/*", apiKeyRateLimitMiddleware);
app.use("/agp/execute", idempotencyMiddleware);
app.use("/agp/execute", executePolicyMiddleware);
app.route("/auth", authApp);
app.route("/connect", createConnectRoutes(adapterRegistry));
app.route("/credentials", credentialsApp);
app.route("/app-credentials", appCredentialsApp);
app.route("/businesses", createBusinessRoutes(adapterRegistry));
app.route("/audit", auditApp);
const adapterApp = createAdapterRoutes(adapterRegistry);
app.route("/", adapterApp);
const keyApp = createKeyRoutes();
app.route("/", keyApp);

app.get("/", (c) => {
  return c.json({
    service: "Agenr POC",
    status: "ok",
    endpoints: [
      "POST /agp/discover",
      "POST /agp/query",
      "POST /agp/execute/prepare",
      "POST /agp/execute",
      "GET /agp/businesses",
      "GET /agp/status/:id",
      "GET /connect/services",
      "GET /connect/:service",
      "GET /connect/:service/callback",
      "GET /auth/google",
      "GET /auth/google/callback",
      "GET /auth/github",
      "GET /auth/github/callback",
      "GET /auth/me",
      "POST /auth/logout",
      "GET /credentials",
      "GET /credentials/:service/activity",
      "POST /credentials/:service",
      "DELETE /credentials/:service",
      "POST /businesses",
      "GET /businesses",
      "GET /businesses/:id",
      "GET /businesses/:id/activity",
      "GET /businesses/:id/connections",
      "DELETE /businesses/:id/connections/:service",
      "PUT /businesses/:id",
      "DELETE /businesses/:id",
      "GET /app-credentials",
      "POST /app-credentials/:service",
      "DELETE /app-credentials/:service",
      "GET /audit/verify",
      "GET /adapters",
      "GET /adapters/archived",
      "POST /adapters/generate",
      "GET /adapters/jobs",
      "GET /adapters/jobs/:id",
      "DELETE /adapters/:platform",
      "DELETE /adapters/:platform/hard",
      "POST /adapters/:platform/promote",
      "POST /adapters/:platform/demote",
      "POST /keys",
      "GET /keys/me",
      "GET /keys",
      "DELETE /keys/:id",
      "POST /keys/:id/link",
      "GET /health",
    ],
  });
});

app.post("/agp/discover", requireScope("discover"), async (c) => {
  const parsedBody = await parseJsonBody(c);
  if (!parsedBody.ok) {
    return c.json(
      {
        error: "Invalid request",
        message: "Request body must be valid JSON.",
        code: "VALIDATION_ERROR",
        requestId: c.get("requestId") ?? "unknown",
      },
      400,
    );
  }

  try {
    const body = discoverSchema.parse(parsedBody.data);
    const demoKeyRestriction = enforceDemoBusinessScope(c, body.businessId);
    if (demoKeyRestriction) {
      return demoKeyRestriction;
    }
    const result = await agpService.discover(body, resolveCallerId(c));
    return c.json(result);
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

app.post("/agp/query", requireScope("query"), async (c) => {
  const parsedBody = await parseJsonBody(c);
  if (!parsedBody.ok) {
    return c.json(
      {
        error: "Invalid request",
        message: "Request body must be valid JSON.",
        code: "VALIDATION_ERROR",
        requestId: c.get("requestId") ?? "unknown",
      },
      400,
    );
  }

  try {
    const body = querySchema.parse(parsedBody.data);
    const demoKeyRestriction = enforceDemoBusinessScope(c, body.businessId);
    if (demoKeyRestriction) {
      return demoKeyRestriction;
    }
    const result = await agpService.query(body, resolveCallerId(c));
    return c.json(result);
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

app.post("/agp/execute/prepare", requireScope("execute"), async (c) => {
  const parsedBody = await parseJsonBody(c);
  if (!parsedBody.ok) {
    return c.json(
      {
        error: "Invalid request",
        message: "Request body must be valid JSON.",
        code: "VALIDATION_ERROR",
        requestId: c.get("requestId") ?? "unknown",
      },
      400,
    );
  }

  try {
    const body = executeSchema.parse(parsedBody.data);
    const demoKeyRestriction = enforceDemoBusinessScope(c, body.businessId);
    if (demoKeyRestriction) {
      return demoKeyRestriction;
    }
    const result = await prepareExecuteConfirmation(body);
    return c.json(result);
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

app.post("/agp/execute", requireScope("execute"), async (c) => {
  const parsedBody = await parseJsonBody(c);
  if (!parsedBody.ok) {
    return c.json(
      {
        error: "Invalid request",
        message: "Request body must be valid JSON.",
        code: "VALIDATION_ERROR",
        requestId: c.get("requestId") ?? "unknown",
      },
      400,
    );
  }

  try {
    const body = executeSchema.parse(parsedBody.data);
    const demoKeyRestriction = enforceDemoBusinessScope(c, body.businessId);
    if (demoKeyRestriction) {
      return demoKeyRestriction;
    }
    const idempotencyKey = c.req.header("idempotency-key")?.trim();
    if (idempotencyKey) {
      body.request = { ...body.request, idempotencyKey };
    }
    const result = await agpService.execute(body, resolveCallerId(c));
    return c.json(result);
  } catch (error) {
    return toErrorResponse(c, error);
  }
});

app.get("/agp/status/:id", async (c) => {
  const transaction = await agpService.status(c.req.param("id"), resolveCallerId(c));
  if (!transaction) {
    return c.json(
      {
        error: "Transaction not found",
        message: "No transaction exists for the provided ID.",
        code: "TRANSACTION_NOT_FOUND",
        requestId: c.get("requestId") ?? "unknown",
      },
      404,
    );
  }

  return c.json(transaction);
});

function toErrorResponse(c: Context, error: unknown) {
  const requestId = c.get("requestId") ?? "unknown";

  if (error instanceof z.ZodError) {
    return c.json(
      {
        error: "Invalid request",
        message: "The request body did not match the expected schema. See 'details' for specific field errors.",
        code: "VALIDATION_ERROR",
        details: z.treeifyError(error),
        requestId,
      },
      400,
    );
  }

  if (error instanceof AdapterExecutionTimeoutError) {
    return c.json(
      {
        error: error.message,
        message:
          "The adapter did not respond within the timeout period. Try again or contact the adapter developer.",
        code: "ADAPTER_TIMEOUT",
        requestId,
      },
      504,
    );
  }

  if (error instanceof AdapterOperationError) {
    return c.json(
      {
        error: "Adapter error",
        message: error.message,
        code: "ADAPTER_ERROR",
        requestId,
      },
      502,
    );
  }

  if (error instanceof Error && error.message.startsWith("Unknown business '")) {
    const businessId = error.message.match(/^Unknown business '(.+)'$/)?.[1] ?? "unknown";
    return c.json(
      {
        error: error.message,
        message: `No business registered with ID '${businessId}'. Check the businessId and try again.`,
        code: "BUSINESS_NOT_FOUND",
        requestId,
      },
      400,
    );
  }

  if (error instanceof Error && error.message.startsWith("No adapter registered for platform '")) {
    const platform = error.message.match(/^No adapter registered for platform '(.+)'$/)?.[1] ?? "unknown";
    return c.json(
      {
        error: error.message,
        message: `No adapter is registered for platform '${platform}'. The business may not have a compatible adapter.`,
        code: "ADAPTER_NOT_FOUND",
        requestId,
      },
      400,
    );
  }

  logger.error("http_request_unhandled_error", {
    requestId,
    error,
  });
  return c.json(
    {
      error: "Internal server error",
      message: "An unexpected server error occurred while processing the request.",
      code: "INTERNAL_ERROR",
      requestId,
    },
    500,
  );
}

function resolveCallerId(c: Context): string {
  return c.get("userId") ?? c.get("apiKeyId") ?? "admin";
}

function enforceDemoBusinessScope(c: Context, businessId: string): Response | null {
  if (c.get("apiKeyId") === DEMO_KEY_ID && businessId !== ECHO_BUSINESS_ID) {
    return c.json(
      {
        error: "Demo key can only be used with the echo business",
        message: "This demo key is restricted to businessId 'echo'.",
        code: "DEMO_KEY_RESTRICTED",
        requestId: c.get("requestId") ?? "unknown",
      },
      403,
    );
  }

  return null;
}

function logStartupWarnings(): void {
  if (!process.env.AGENR_API_KEY?.trim()) {
    logger.warn("startup_env_missing_agenr_api_key", {
      message:
        "AGENR_API_KEY not set; admin backdoor disabled (local dev allows unauthenticated access only when no DB API keys exist)",
    });
  }

  if (!process.env.AGENR_CORS_ORIGINS?.trim()) {
    logger.warn("startup_env_missing_agenr_cors_origins", {
      message: "AGENR_CORS_ORIGINS not set; CORS denies cross-origin requests by default",
    });
  }

  const policyRaw = process.env.AGENR_EXECUTE_POLICY?.trim().toLowerCase();
  if (!policyRaw || resolveExecutePolicy() === "open") {
    logger.warn("startup_execute_policy_open", {
      policy: "open",
      message: "No confirmation required for transactions",
    });
  }
}

const port = parseInt(process.env.PORT || "3001", 10);

logStartupWarnings();
logger.info("startup_server_listening", {
  url: `http://localhost:${port}`,
  port,
});
export default {
  hostname: "0.0.0.0",
  port,
  fetch: app.fetch,
};
