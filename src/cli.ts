#!/usr/bin/env node
import {
  loadConfig,
  setConfigApiKey,
  setConfigModel,
  setConfigProvider,
  setConfigSubscriptionToken,
} from "./cli/config-store";
import { migrate } from "./db/migrate";
import {
  detectProviderFromApiKey,
  detectProviderFromSubscriptionToken,
  formatCredentialSummary,
} from "./cli/credentials";
import { resolveLlmRuntime } from "./cli/llm-client";
import { normalizeModelAlias } from "./cli/model-aliases";
import { resolveConfigPath } from "./cli/paths";
import { runGeneration } from "./cli/generator";
import { runAdapterTestCommand } from "./cli/adapter-test";
import { DEMO_USERS, demoUserIds, runDemoReset } from "./cli/demo-reset";
import type { ApiKeyProvider, LlmProviderPreference } from "./cli/types";
import { deleteAppCredential, listAppCredentials, storeAppCredential } from "./vault/app-credential-store";

function printHelp(): void {
  console.log(`Agenr CLI

Usage:
  agenr generate <platform-name> [--docs-url <url>] [--provider <provider>] [--model <model>] [--verbose] [--quiet|--no-thinking] [--skip-discovery] [--rediscover]
  agenr test --list
  agenr test <platform> [--verbose] [--include-execute]
  agenr demo-reset [--db-url <url>] [--db-token <token>] [--confirm]
  agenr config show
  agenr config show oauth
  agenr config set provider <openai-api|codex|claude-code|anthropic-api>
  agenr config set model <model|default>
  agenr config set subscription-token <token>
  agenr config set api-key <openai|anthropic> <key|clear>
  agenr config set oauth <service> <client-id> <client-secret>
  agenr config remove oauth <service>

Examples:
  agenr generate Toast
  agenr generate Toast --docs-url https://doc.toasttab.com
  agenr generate Toast --verbose
  agenr generate Toast --quiet
  agenr generate Stripe --skip-discovery
  agenr generate Stripe --rediscover
  agenr test --list
  agenr test square
  agenr test stripe --verbose --include-execute
  agenr demo-reset --db-url libsql://your-db.turso.io --db-token <token>
  agenr demo-reset --confirm
  agenr config show
  agenr config set provider codex
  agenr config set provider claude-code
  agenr config set provider openai-api
  agenr config set provider anthropic-api
  agenr config set model codex
  agenr config set subscription-token sk-ant-oat-...
  agenr config set api-key anthropic sk-ant-...
  agenr config set api-key openai sk-proj-...
  agenr config set oauth stripe ca_test_123 sk_test_123
  agenr config show oauth
  agenr config remove oauth stripe
`);
}

function parseProvider(value: string): LlmProviderPreference {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "codex" ||
    normalized === "claude-code" ||
    normalized === "openai-api" ||
    normalized === "anthropic-api"
  ) {
    return normalized;
  }

  throw new Error(`Invalid provider '${value}'. Use openai-api, codex, claude-code, or anthropic-api.`);
}

function parseApiKeyProvider(value: string): ApiKeyProvider | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "openai" || normalized === "anthropic") {
    return normalized;
  }

  return null;
}

function parseGenerateArgs(args: string[]): {
  platformName: string;
  docsUrl?: string;
  providerOverride?: LlmProviderPreference;
  modelOverride?: string;
  verbose: boolean;
  showThinking: boolean;
  skipDiscovery: boolean;
  rediscover: boolean;
} {
  const platformParts: string[] = [];
  let docsUrl: string | undefined;
  let providerOverride: LlmProviderPreference | undefined;
  let modelOverride: string | undefined;
  let verbose = false;
  let showThinking = true;
  let skipDiscovery = false;
  let rediscover = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";

    if (arg === "--docs-url") {
      const value = args[++i];
      if (!value) throw new Error("Missing value for --docs-url");
      docsUrl = value;
      continue;
    }

    if (arg === "--provider") {
      const value = args[++i];
      if (!value) throw new Error("Missing value for --provider");
      providerOverride = parseProvider(value);
      continue;
    }

    if (arg === "--model") {
      const value = args[++i];
      if (!value) throw new Error("Missing value for --model");
      modelOverride = normalizeModelAlias(value);
      continue;
    }

    if (arg === "--verbose") {
      verbose = true;
      continue;
    }

    if (arg === "--quiet" || arg === "--no-thinking") {
      showThinking = false;
      continue;
    }

    if (arg === "--skip-discovery") {
      skipDiscovery = true;
      continue;
    }

    if (arg === "--rediscover") {
      rediscover = true;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag '${arg}'`);
    }

    platformParts.push(arg);
  }

  const platformName = platformParts.join(" ").trim();
  if (!platformName) {
    throw new Error(
      "Missing <platform-name>. Usage: agenr generate <platform-name> [--docs-url <url>] [--skip-discovery] [--rediscover]",
    );
  }

  if (skipDiscovery && rediscover) {
    throw new Error("--skip-discovery and --rediscover cannot be used together.");
  }

  return {
    platformName,
    docsUrl,
    providerOverride,
    modelOverride,
    verbose,
    showThinking,
    skipDiscovery,
    rediscover,
  };
}

function parseDemoResetArgs(args: string[]): {
  dbUrl: string;
  dbToken: string;
  confirm: boolean;
} {
  let dbUrl = process.env.AGENR_DB_URL ?? "";
  let dbToken = process.env.AGENR_DB_AUTH_TOKEN ?? "";
  let confirm = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--db-url") {
      const value = args[++i];
      if (!value) {
        throw new Error("Missing value for --db-url");
      }
      dbUrl = value;
      continue;
    }

    if (arg === "--db-token") {
      const value = args[++i];
      if (!value) {
        throw new Error("Missing value for --db-token");
      }
      dbToken = value;
      continue;
    }

    if (arg === "--confirm") {
      confirm = true;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag '${arg}'`);
    }

    throw new Error(`Unexpected argument '${arg}'. Usage: agenr demo-reset [--db-url <url>] [--db-token <token>] [--confirm]`);
  }

  if (!dbUrl.trim()) {
    throw new Error("Missing database URL. Provide --db-url or set AGENR_DB_URL.");
  }

  return {
    dbUrl,
    dbToken,
    confirm,
  };
}

function printDemoResetPreview(dbUrl: string): void {
  console.log("[DEMO-RESET] Dry run (no changes applied)");
  console.log(`[DEMO-RESET] Target DB: ${dbUrl}`);
  console.log(`[DEMO-RESET] Demo users: ${demoUserIds().join(", ")}`);
  console.log("[DEMO-RESET] Would delete per demo user:");
  console.log("  - businesses WHERE owner_id = <demo-user-id>");
  console.log("  - credentials WHERE user_id = <demo-user-id>");
  console.log("  - user_keys WHERE user_id = <demo-user-id>");
  console.log("  - sessions WHERE user_id = <demo-user-id>");
  console.log("  - credential_audit_log is intentionally preserved (append-only)");
  console.log("[DEMO-RESET] Would upsert demo users and reinsert hashed demo sessions.");
  console.log("[DEMO-RESET] Re-run with --confirm to execute.");
}

async function handleDemoResetCommand(args: string[]): Promise<void> {
  const parsed = parseDemoResetArgs(args);
  if (!parsed.confirm) {
    printDemoResetPreview(parsed.dbUrl);
    return;
  }

  console.log(`[DEMO-RESET] Running reset against ${parsed.dbUrl}`);
  const summary = await runDemoReset(parsed.dbUrl, parsed.dbToken);
  const totalDeleted = summary.deleted.reduce(
    (acc, item) => acc + item.businesses + item.credentials + item.userKeys + item.sessions,
    0,
  );
  console.log(
    `[DEMO-RESET] Done. deleted=${totalDeleted}, users_upserted=${summary.usersUpserted}, sessions_upserted=${summary.sessionsUpserted}, demo_users=${DEMO_USERS.length}`,
  );
}

function maskApiKey(value: string | null): string {
  if (!value) return "(not set)";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function showConfig(): Promise<void> {
  const config = loadConfig();

  console.log(`Config file: ${resolveConfigPath()}`);
  console.log(`Configured provider: ${config.llm.provider}`);
  console.log(`Configured model: ${config.llm.model ?? "(default)"}`);
  console.log(`Configured subscription token: ${maskApiKey(config.llm.subscriptionToken)}`);
  console.log(`Configured api key (openai): ${maskApiKey(config.llm.apiKeys.openai)}`);
  console.log(`Configured api key (anthropic): ${maskApiKey(config.llm.apiKeys.anthropic)}`);

  try {
    const runtime = await resolveLlmRuntime(config);
    console.log(`Provider: ${runtime.provider} (${runtime.source})`);
    console.log(`Model: ${runtime.model}`);
    console.log(
      `Credentials: ${formatCredentialSummary({
        provider: runtime.provider,
        source: runtime.source,
        authMode: runtime.authMode,
        token: runtime.token,
        refreshToken: runtime.refreshToken,
        expiresAt: runtime.expiresAt,
        accountId: runtime.accountId,
        baseUrl: runtime.baseUrl,
      })}`,
    );
    console.log(`Auth mode: ${runtime.authMode}`);
    console.log(`Base URL: ${runtime.baseUrl}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Credentials: unresolved (${message})`);
  }
}

function normalizeOAuthService(value: string | undefined): string {
  const service = value?.trim().toLowerCase() ?? "";
  if (!service) {
    throw new Error("OAuth service is required.");
  }

  return service;
}

async function showOAuthConfig(): Promise<void> {
  await migrate();
  const credentials = await listAppCredentials();

  if (credentials.length === 0) {
    console.log("OAuth app credentials: none configured.");
    return;
  }

  console.log("OAuth app credentials:");
  for (const credential of credentials) {
    console.log(`- ${credential.service} (created: ${credential.createdAt}, updated: ${credential.updatedAt})`);
  }
}

async function setConfig(args: string[]): Promise<void> {
  const key = args[1];
  if (!key) {
    throw new Error("Usage: agenr config set <provider|model|subscription-token|api-key|oauth> <value>");
  }

  if (key === "api-key") {
    const apiKeyArgs = args.slice(2);
    if (apiKeyArgs.length < 2) {
      throw new Error("Usage: agenr config set api-key <openai|anthropic> <key|clear>");
    }

    const explicitProvider = parseApiKeyProvider(apiKeyArgs[0] ?? "");
    if (!explicitProvider) {
      throw new Error("Invalid API key provider. Use openai or anthropic.");
    }

    const value = apiKeyArgs.slice(1).join(" ").trim();
    if (!value) {
      throw new Error("Usage: agenr config set api-key <openai|anthropic> <key|clear>");
    }

    const normalized = value.toLowerCase() === "clear" ? null : value;

    const subscriptionProvider = normalized ? detectProviderFromSubscriptionToken(normalized) : null;
    if (subscriptionProvider) {
      if (subscriptionProvider === "openai-codex") {
        throw new Error(
          "This value looks like a Codex subscription JWT token. Use provider 'codex' (Codex CLI OAuth) instead of api-key auth.",
        );
      }
      throw new Error(
        `This value looks like a ${subscriptionProvider} subscription token. Use: agenr config set subscription-token <token>`,
      );
    }

    const inferredProvider = normalized ? detectProviderFromApiKey(normalized) : null;

    if (normalized) {
      if (explicitProvider === "anthropic" && inferredProvider !== "anthropic") {
        throw new Error("Provider/key mismatch: expected an Anthropic API key (sk-ant-...).");
      }
      if (explicitProvider === "openai" && inferredProvider === "anthropic") {
        throw new Error("Provider/key mismatch: expected an OpenAI API key, got Anthropic format.");
      }
    }

    setConfigApiKey(explicitProvider, normalized);
    if (!normalized) {
      console.log(`API key cleared for provider '${explicitProvider}'.`);
      return;
    }

    console.log(`API key saved for provider '${explicitProvider}'.`);
    return;
  }

  if (key === "oauth") {
    const service = normalizeOAuthService(args[2]);
    const clientId = args[3]?.trim() ?? "";
    const clientSecret = args.slice(4).join(" ").trim();
    if (!clientId || !clientSecret) {
      throw new Error("Usage: agenr config set oauth <service> <client-id> <client-secret>");
    }

    await migrate();
    await storeAppCredential(service, {
      clientId,
      clientSecret,
    });
    console.log(`OAuth app credential configured for '${service}'.`);
    return;
  }

  const value = args.slice(2).join(" ").trim();
  if (!value) {
    throw new Error("Usage: agenr config set <provider|model|subscription-token|api-key|oauth> <value>");
  }

  if (key === "provider") {
    const provider = parseProvider(value);
    setConfigProvider(provider);
    console.log(`Updated provider to '${provider}'.`);
    return;
  }

  if (key === "model") {
    const normalized = value.toLowerCase() === "default" ? null : normalizeModelAlias(value);
    setConfigModel(normalized);
    console.log(`Updated model to '${normalized ?? "(default)"}'.`);
    return;
  }

  if (key === "subscription-token") {
    const normalized = value.toLowerCase() === "clear" ? null : value;
    if (!normalized) {
      setConfigSubscriptionToken(null);
      console.log("Subscription token cleared from config.");
      return;
    }

    const detectedProvider = detectProviderFromSubscriptionToken(normalized);
    if (!detectedProvider) {
      throw new Error(
        "Unrecognized subscription token format. Expected a Claude setup-token value (sk-ant-oat...).",
      );
    }
    if (detectedProvider === "openai-codex") {
      throw new Error(
        "Codex subscription tokens are not accepted directly. Agenr uses Codex CLI OAuth for provider 'codex'.",
      );
    }

    setConfigSubscriptionToken(normalized);
    console.log(`Subscription token saved to config (detected provider: ${detectedProvider}).`);
    return;
  }

  throw new Error(`Unknown config key '${key}'. Use provider, model, subscription-token, api-key, or oauth.`);
}

async function removeConfig(args: string[]): Promise<void> {
  const key = args[1];
  if (key !== "oauth") {
    throw new Error("Usage: agenr config remove oauth <service>");
  }

  const service = normalizeOAuthService(args[2]);
  await migrate();
  await deleteAppCredential(service);
  console.log(`OAuth app credential removed for '${service}'.`);
}

async function handleConfigCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand) {
    await showConfig();
    return;
  }

  if (subcommand === "show") {
    const target = args[1]?.trim().toLowerCase();
    if (!target) {
      await showConfig();
      return;
    }

    if (target === "oauth") {
      await showOAuthConfig();
      return;
    }

    throw new Error("Usage: agenr config show [oauth]");
  }

  if (subcommand === "set") {
    await setConfig(args);
    return;
  }

  if (subcommand === "remove") {
    await removeConfig(args);
    return;
  }

  throw new Error("Usage: agenr config <show|set|remove>");
}

async function handleGenerateCommand(args: string[]): Promise<void> {
  const parsed = parseGenerateArgs(args);
  const result = await runGeneration(parsed, (message) => console.log(message));

  console.log("Generation complete.");
  console.log(`Adapter: ${result.adapterPath}`);
  console.log(`Interaction profile: ${result.profilePath}`);
  console.log(`Attempts: ${result.attempts}`);
  console.log(`User profile: ${result.businessProfileUpdate.profilePath}`);

  if (result.businessProfileUpdate.status === "added" && result.businessProfileUpdate.businessEntry) {
    console.log("Added business entry:");
    console.log(JSON.stringify(result.businessProfileUpdate.businessEntry, null, 2));
  } else {
    console.log(result.businessProfileUpdate.message);
  }
}

async function handleTestCommand(args: string[]): Promise<void> {
  const exitCode = await runAdapterTestCommand(args);
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "config") {
    await handleConfigCommand(rest);
    return;
  }

  if (command === "generate") {
    await handleGenerateCommand(rest);
    return;
  }

  if (command === "test") {
    await handleTestCommand(rest);
    return;
  }

  if (command === "demo-reset") {
    await handleDemoResetCommand(rest);
    return;
  }

  throw new Error(`Unknown command '${command}'.`);
}

if (import.meta.main) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  });
}
