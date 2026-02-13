import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { z } from "zod";

import { loadConfig } from "./config-store";
import {
  DiscoveryCacheReadError,
  formatCacheAge,
  isFreshDiscoveryCache,
  readDiscoveryCache,
  writeDiscoveryCache,
} from "./discovery-cache";
import { runDiscoveryAgent } from "./discovery-agent";
import type { DiscoveryFindings, DiscoveryResult } from "./discovery-types";
import { isLlmAuthError, resolveLlmRuntime, streamPrompt } from "./llm-client";
import {
  resolveAdapterPath,
  resolveDiscoveryCachePath,
  resolveInteractionProfilePath,
  resolveProjectRoot,
  resolveRelativeToRoot,
} from "./paths";
import type {
  ConfigOverrides,
  GeneratedArtifacts,
  GenerationOptions,
  ResolvedLlmRuntime,
  SearchResult,
} from "./types";

const interactionCapabilitySchema = z.object({
  operation: z.enum(["discover", "query", "execute"]),
  method: z.string().min(1),
  endpoint: z.string().min(1),
  authRequired: z.boolean(),
  description: z.string().min(1),
});

const interactionProfileSchema = z.object({
  platform: z.string().min(1),
  version: z.string().min(1),
  generated: z.string().min(1),
  method: z.enum(["manual", "ai-generated"]),
  capabilities: z.object({
    discover: interactionCapabilitySchema,
    query: interactionCapabilitySchema,
    execute: interactionCapabilitySchema,
  }),
});

interface FewShotContext {
  adapterApi: string;
  referenceAdapter: string;
  referenceInteractionProfile: string;
}

interface GenerationResult {
  adapterPath: string;
  profilePath: string;
  attempts: number;
  docsUsed: SearchResult[];
  runtime: ResolvedLlmRuntime;
  businessProfileUpdate: BusinessProfileUpdateResult;
}

interface BusinessProfileUpdateResult {
  profilePath: string;
  status: "added" | "exists" | "skipped";
  businessEntry?: Record<string, unknown>;
  message: string;
}

type UnknownRecord = Record<string, unknown>;
const ADAPTER_API_IMPORT_ALIAS = "agenr:adapter-api";

function slugifyPlatformName(platformName: string): string {
  return platformName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .replace(/-{2,}/g, "-");
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function toRecord(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as UnknownRecord;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function profilePathFromEnvOrDefault(projectRoot: string): string {
  const envPath = process.env.AGENR_USER_PROFILE_PATH;
  if (envPath && envPath.trim()) {
    const normalized = envPath.trim();
    return path.isAbsolute(normalized) ? normalized : path.resolve(projectRoot, normalized);
  }

  return path.join(projectRoot, "data", "user-profile.json");
}

function stripFindingSourceSuffix(value: string): string {
  return value.replace(/\s*\(source:\s*https?:\/\/[^)]+\)\s*$/i, "").trim();
}

function flattenFindings(findings: DiscoveryFindings): string[] {
  const orderedCategories = Object.keys(findings).sort((a, b) => {
    const score = (category: string): number => {
      if (category.includes("business") || category.includes("merchant") || category.includes("account")) return 3;
      if (category.includes("discover") || category.includes("profile")) return 2;
      if (category.includes("notes")) return 1;
      return 0;
    };

    return score(b) - score(a) || a.localeCompare(b);
  });

  return orderedCategories.flatMap((category) => findings[category] ?? []);
}

function extractDisplayNameFromFindings(platformName: string, findings: DiscoveryFindings): string {
  const entries = flattenFindings(findings).map(stripFindingSourceSuffix);
  const explicitPatterns = [
    /\b(?:business|merchant|store|restaurant|location|account)\s*name\b[^:=-]*[:=-]\s*["']?([^"'\n;(),]{2,80})/i,
    /\bdisplay\s*name\b[^:=-]*[:=-]\s*["']?([^"'\n;(),]{2,80})/i,
    /"name"\s*:\s*"([^"]{2,80})"/i,
    /\bname\b\s*[:=-]\s*["']([^"']{2,80})["']/i,
  ];

  for (const entry of entries) {
    for (const pattern of explicitPatterns) {
      const match = entry.match(pattern);
      const candidate = match?.[1]?.trim();
      if (!candidate) continue;

      if (/^https?:\/\//i.test(candidate)) continue;
      if (candidate.toLowerCase() === "name") continue;
      return candidate;
    }
  }

  const fallback = platformName.trim();
  return fallback || "Generated Business";
}

function extractEnvVarNamesFromAdapterSource(adapterSource: string): string[] {
  const matches = Array.from(adapterSource.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g));
  return Array.from(new Set(matches.map((match) => match[1]).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function extractUrlsFromText(value: string): string[] {
  const matches = Array.from(value.matchAll(/https?:\/\/[^\s"'`)<>\]]+/g));
  return matches.map((match) => match[0]).filter(Boolean);
}

function extractBaseUrlsFromAdapterSource(adapterSource: string): string[] {
  const urls = extractUrlsFromText(adapterSource)
    .map((url) => {
      try {
        return new URL(url).toString();
      } catch {
        return null;
      }
    })
    .filter((url): url is string => Boolean(url));

  return Array.from(new Set(urls)).sort((a, b) => a.localeCompare(b));
}

function extractUrlsFromInteractionProfile(interactionProfileJson: string): string[] {
  try {
    const profile = toRecord(JSON.parse(interactionProfileJson) as unknown);
    const capabilities = toRecord(profile.capabilities);
    const endpoints = Object.values(capabilities)
      .map((value) => readString(toRecord(value).endpoint))
      .filter((value): value is string => Boolean(value));

    const urls = endpoints.flatMap((endpoint) => extractUrlsFromText(endpoint));
    return Array.from(new Set(urls)).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function inferEnvironment(platformSlug: string, findings: DiscoveryFindings, envVars: string[]): string {
  const haystack = `${flattenFindings(findings).join("\n")} ${envVars.join(" ")}`.toLowerCase();

  if (haystack.includes("sandbox")) {
    return platformSlug === "stripe" ? "test" : "sandbox";
  }

  if (/\btest(?:ing)?\b/.test(haystack) || /\blivemode\s*[:=]\s*false\b/.test(haystack)) {
    return platformSlug === "toast" || platformSlug === "square" ? "sandbox" : "test";
  }

  if (/\bprod(?:uction)?\b/.test(haystack) || /\blive\b/.test(haystack)) {
    return platformSlug === "stripe" ? "live" : "production";
  }

  if (platformSlug === "stripe") return "test";
  return "sandbox";
}

function locationFromEnvironment(environment: string): string {
  const normalized = environment.trim().toLowerCase();
  if (
    normalized === "sandbox" ||
    normalized === "test" ||
    normalized === "testing" ||
    normalized === "demo" ||
    normalized === "development"
  ) {
    return "Sandbox";
  }

  return "Unknown";
}

function buildPlatformConfigBlock(params: {
  platformSlug: string;
  findings: DiscoveryFindings;
  adapterSource: string;
  interactionProfileJson: string;
  sourceUrls: string[];
}): UnknownRecord {
  const envVars = extractEnvVarNamesFromAdapterSource(params.adapterSource);
  const environment = inferEnvironment(params.platformSlug, params.findings, envVars);
  const adapterBaseUrls = extractBaseUrlsFromAdapterSource(params.adapterSource);
  const profileUrls = extractUrlsFromInteractionProfile(params.interactionProfileJson);
  const discoveryUrls = params.sourceUrls
    .map((rawUrl) => {
      try {
        return new URL(rawUrl).toString();
      } catch {
        return null;
      }
    })
    .filter((value): value is string => Boolean(value));
  const allUrls = Array.from(new Set([...adapterBaseUrls, ...profileUrls, ...discoveryUrls])).sort((a, b) =>
    a.localeCompare(b),
  );
  const likelyApiUrls = allUrls.filter((url) => {
    const lower = url.toLowerCase();
    return lower.includes("api.") || lower.includes("/api") || lower.includes("/v1") || lower.includes("/v2");
  });
  const config: UnknownRecord = { environment };

  if (likelyApiUrls.length === 1) {
    config.baseUrl = likelyApiUrls[0];
  } else if (likelyApiUrls.length > 1) {
    config.baseUrls = likelyApiUrls;
  }

  const relevantEnvVars = envVars.filter((name) =>
    /KEY|TOKEN|SECRET|CLIENT|ACCOUNT|MERCHANT|LOCATION/.test(name),
  );
  if (relevantEnvVars.length === 1) {
    config.apiKeyEnv = relevantEnvVars[0];
  } else if (relevantEnvVars.length > 1) {
    config.apiKeyEnvs = relevantEnvVars;
  }

  return config;
}

function buildBusinessId(baseName: string, businesses: UnknownRecord[]): string {
  const trimmed = baseName
    .trim()
    .replace(/\b(store|business|location|restaurant|merchant|account|shop)\b\s*$/i, "")
    .trim();
  const seed = slugifyPlatformName(trimmed) || slugifyPlatformName(baseName) || "generated-business";
  const existingIds = new Set(
    businesses
      .map((business) => slugifyPlatformName(readString(business["id"]) ?? ""))
      .filter(Boolean),
  );

  if (!existingIds.has(seed)) {
    return seed;
  }

  let suffix = 2;
  while (existingIds.has(`${seed}-${suffix}`)) {
    suffix += 1;
  }

  return `${seed}-${suffix}`;
}

function syncGeneratedBusinessToUserProfile(params: {
  projectRoot: string;
  platformName: string;
  platformSlug: string;
  findings: DiscoveryFindings;
  sourceUrls: string[];
  adapterSource: string;
  interactionProfileJson: string;
}): BusinessProfileUpdateResult {
  const profilePath = profilePathFromEnvOrDefault(params.projectRoot);
  const fallbackProfile = {
    user: "user",
    businesses: [] as UnknownRecord[],
  };

  let rawProfile: UnknownRecord = {};
  if (fs.existsSync(profilePath)) {
    try {
      rawProfile = JSON.parse(fs.readFileSync(profilePath, "utf8")) as UnknownRecord;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        profilePath,
        status: "skipped",
        message: `Could not parse user profile at '${profilePath}': ${message}`,
      };
    }
  } else {
    rawProfile = fallbackProfile;
  }

  const profileRecord = {
    ...fallbackProfile,
    ...toRecord(rawProfile),
  };
  const businesses = Array.isArray(profileRecord.businesses)
    ? profileRecord.businesses.map((value) => toRecord(value))
    : [];

  const existing = businesses.find(
    (business) => slugifyPlatformName(readString(business["platform"]) ?? "") === params.platformSlug,
  );
  if (existing) {
    return {
      profilePath,
      status: "exists",
      message: `Business for platform '${params.platformSlug}' already exists in '${profilePath}'.`,
      businessEntry: existing,
    };
  }

  const name = extractDisplayNameFromFindings(params.platformName, params.findings);
  const configBlock = buildPlatformConfigBlock({
    platformSlug: params.platformSlug,
    findings: params.findings,
    adapterSource: params.adapterSource,
    interactionProfileJson: params.interactionProfileJson,
    sourceUrls: params.sourceUrls,
  });
  const environment = readString(configBlock.environment) ?? "sandbox";
  const location = locationFromEnvironment(environment);
  const id = buildBusinessId(name, businesses);
  const businessEntry: UnknownRecord = {
    id,
    name,
    platform: params.platformSlug,
    location,
    preferences: {},
    [params.platformSlug]: configBlock,
  };

  businesses.push(businessEntry);
  const nextProfile: UnknownRecord = {
    ...profileRecord,
    user: readString(profileRecord.user) ?? "user",
    businesses,
  };

  ensureParentDirectory(profilePath);
  fs.writeFileSync(profilePath, `${JSON.stringify(nextProfile, null, 2)}\n`, "utf8");
  fs.chmodSync(profilePath, 0o600);

  return {
    profilePath,
    status: "added",
    businessEntry,
    message: `Added business for platform '${params.platformSlug}' to '${profilePath}'.`,
  };
}

function readFewShotContext(): FewShotContext {
  const adapterApiPath = resolveRelativeToRoot("src", "adapter-api.ts");
  const referenceAdapterPath = resolveRelativeToRoot("data", "few-shot", "stripe.ts");
  const referenceProfilePath = resolveRelativeToRoot("data", "interaction-profiles", "stripe.json");

  try {
    return {
      adapterApi: fs.readFileSync(adapterApiPath, "utf8"),
      referenceAdapter: fs.readFileSync(referenceAdapterPath, "utf8"),
      referenceInteractionProfile: fs.readFileSync(referenceProfilePath, "utf8"),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load few-shot context from '${adapterApiPath}', '${referenceAdapterPath}', and '${referenceProfilePath}': ${message}`,
    );
  }
}

function normalizePathForPrompt(value: string): string {
  return value.replace(/\\/g, "/");
}

function resolveAdapterOutputPath(
  projectRoot: string,
  platformSlug: string,
  adapterOutputPath: string | undefined,
): string {
  const configuredOutputPath = adapterOutputPath?.trim();
  if (!configuredOutputPath) {
    return resolveAdapterPath(platformSlug);
  }

  if (path.isAbsolute(configuredOutputPath)) {
    return configuredOutputPath;
  }

  return path.resolve(projectRoot, configuredOutputPath);
}

function buildGenerationPrompt(params: {
  platformName: string;
  platformSlug: string;
  adapterClassName: string;
  adapterFilePathHint: string;
  adapterApiImportPath: string;
  analysisSummary: string;
  fewShot: FewShotContext;
  currentDate: string;
  previousErrors?: string;
}): string {
  return [
    "You are generating an Agenr AGP adapter from API docs.",
    `Target platform: ${params.platformName}`,
    `Target slug: ${params.platformSlug}`,
    `Required adapter class name: ${params.adapterClassName}`,
    "Requirements:",
    "1. Create an interaction profile JSON that matches the existing profile schema.",
    "2. method must be \"ai-generated\".",
    `3. generated must be '${params.currentDate}' (YYYY-MM-DD).`,
    "4. platform must match the target slug.",
    "5. Create a TypeScript adapter implementing AgpAdapter with discover/query/execute methods and default-export the class.",
    "6. Constructor signature MUST be: (businessProfile: BusinessProfile, ctx: AdapterContext). Store both as private readonly fields.",
    "7. Use this.ctx.fetch() for ALL HTTP calls. Never call global fetch().",
    "8. Do NOT import or use getValidToken, tokenStore, or any auth helper. For most auth strategies (oauth2, bearer, api-key-header, basic, cookie, custom), do NOT set Authorization headers manually; ctx.fetch() handles auth injection. Exception: for client-credentials strategy, the adapter manages its own token exchange and sets auth headers manually on ctx.fetch() calls.",
    "9. Export manifest using defineManifest() with platform, auth type/strategy, authenticatedDomains, optional allowedDomains, and auth.oauth config (if the platform uses OAuth2).",
    "10. Choose the correct auth strategy based on the platform's API authentication:\n    - \"oauth2\": Platform uses OAuth 2.0 authorization code flow (e.g., GitHub API, Google APIs, Stripe Connect). Set auth.oauth in the manifest with authorizationUrl, tokenUrl, and optionally oauthService and tokenContentType. The platform handles the OAuth redirect flow and token storage. The adapter receives injected Bearer tokens via ctx.fetch() automatically. Do NOT manually handle OAuth token exchange in the adapter code.\n    - \"bearer\": Platform uses a single API key or token as Bearer header (e.g., Stripe, OpenAI). User stores their key, ctx.fetch() injects it.\n    - \"api-key-header\": Platform uses a custom header for the API key (e.g., X-Api-Key). Set headerName in manifest.auth.\n    - \"basic\": Platform uses HTTP Basic auth (username:password).\n    - \"cookie\": Platform uses cookie-based auth. Set cookieName in manifest.auth.\n    - \"custom\": Platform uses a non-standard header. Set headerName in manifest.auth.\n    - \"client-credentials\": Platform requires clientId + clientSecret exchanged for a short-lived access token (e.g., Toast, Twilio, Salesforce). Use ctx.getCredential() to retrieve clientId/clientSecret from vault, do the token exchange via ctx.fetch(), then use the access token in subsequent ctx.fetch() calls with manually-set Authorization header.\n    - \"none\": Platform requires no authentication.",
    "IMPORTANT: For oauth2 adapters, the adapter code is the same as bearer -- just use ctx.fetch() normally. The OAuth flow (redirects, token exchange) is handled by the platform, NOT by the adapter. The manifest auth.oauth config tells the platform how to run the OAuth flow. The adapter just makes API calls with the injected token.",
    "When choosing between 'bearer' and 'oauth2': Use 'oauth2' when the platform's API documentation describes an OAuth 2.0 authorization code flow where users grant access to their account (e.g., 'Connect with GitHub', 'Authorize with Google'). Use 'bearer' when users simply paste an API key or token. Both result in Bearer token injection via ctx.fetch(), but 'oauth2' additionally declares the OAuth flow URLs so the platform can handle the redirect-based authorization.",
    "OAuth auth.oauth fields reference:\n    - oauthService (optional string): Which app credential to use. Defaults to platform name. Use when multiple adapters share one OAuth app (e.g., all GitHub adapters use oauthService: 'github').\n    - authorizationUrl (required string): The OAuth authorization endpoint URL. Must be HTTPS.\n    - tokenUrl (required string): The OAuth token exchange endpoint URL. Must be HTTPS.\n    - tokenContentType (optional \"form\" | \"json\"): Content-Type for token exchange request. Defaults to \"form\". Use \"json\" if the provider expects JSON body.\n    - extraAuthParams (optional Record<string, string>): Extra query params for the authorization URL (e.g., { access_type: \"offline\", prompt: \"consent\" } for Google).",
    `11. The adapter file path is ${params.adapterFilePathHint}.`,
    `12. The adapter must import Agenr types/helpers from '${params.adapterApiImportPath}'.`,
    `    Required import pattern example: import { validateAdapterUrl, type AgpAdapter, type BusinessProfile, type ExecuteOptions, type AdapterContext, defineManifest } from '${params.adapterApiImportPath}';`,
    "13. Keep code strict-TypeScript compatible.",
    "14. Follow the reference dynamic adapter style and patterns where appropriate.",
    "15. If reference snippets conflict with these requirements, follow these requirements. Use ctx.fetch() for all authenticated requests.",
    "Required adapter structure example:",
    "```typescript",
    `import { validateAdapterUrl, type AgpAdapter, type BusinessProfile, type ExecuteOptions, type AdapterContext, defineManifest } from '${params.adapterApiImportPath}'`,
    "",
    "export const manifest = defineManifest({",
    `  platform: '${params.platformSlug}',`,
    "  auth: { type: 'api_key', strategy: 'bearer' },",
    "  authenticatedDomains: ['api.example.com'],",
    "  allowedDomains: [],",
    "})",
    "",
    `export default class ${params.adapterClassName} implements AgpAdapter {`,
    "  constructor(",
    "    private readonly businessProfile: BusinessProfile,",
    "    private readonly ctx: AdapterContext,",
    "  ) {",
    "    validateAdapterUrl('https://api.example.com')",
    "  }",
    "",
    "  async discover(ctx: AdapterContext): Promise<unknown> {",
    "    const res = await ctx.fetch('https://api.example.com/info')",
    "    return res.json()",
    "  }",
    "",
    "  async query(request: Record<string, unknown>, ctx: AdapterContext): Promise<unknown> {",
    "    const res = await ctx.fetch('https://api.example.com/search', {",
    "      method: 'POST',",
    "      headers: { 'Content-Type': 'application/json' },",
    "      body: JSON.stringify(request),",
    "    })",
    "    return res.json()",
    "  }",
    "",
    "  async execute(",
    "    request: Record<string, unknown>,",
    "    options: ExecuteOptions | undefined,",
    "    ctx: AdapterContext,",
    "  ): Promise<unknown> {",
    "    const res = await ctx.fetch('https://api.example.com/action', {",
    "      method: 'POST',",
    "      headers: { 'Content-Type': 'application/json' },",
    "      body: JSON.stringify(request),",
    "    })",
    "    return res.json()",
    "  }",
    "}",
    "```",
    "Example: client-credentials adapter (e.g., Toast, Twilio, Salesforce)",
    "```typescript",
    `import { validateAdapterUrl, type AgpAdapter, type BusinessProfile, type ExecuteOptions, type AdapterContext, defineManifest } from '${params.adapterApiImportPath}'`,
    "",
    "export const manifest = defineManifest({",
    "  platform: 'example-cc',",
    "  auth: { type: 'client_credentials', strategy: 'client-credentials' },",
    "  authenticatedDomains: ['api.example.com'],",
    "  allowedDomains: [],",
    "})",
    "",
    "export default class ExampleCcAdapter implements AgpAdapter {",
    "  private accessToken: string | null = null",
    "  private tokenExpiresAt = 0",
    "",
    "  constructor(",
    "    private readonly businessProfile: BusinessProfile,",
    "    private readonly ctx: AdapterContext,",
    "  ) {",
    "    validateAdapterUrl('https://api.example.com')",
    "  }",
    "",
    "  private async getAccessToken(ctx: AdapterContext): Promise<string> {",
    "    if (this.accessToken && Date.now() < this.tokenExpiresAt - 30_000) {",
    "      return this.accessToken",
    "    }",
    "",
    "    const credential = await ctx.getCredential()",
    "    if (!credential?.clientId || !credential?.clientSecret) {",
    "      throw new Error('No credentials. Store clientId and clientSecret via the Connections page.')",
    "    }",
    "",
    "    const response = await ctx.fetch('https://api.example.com/oauth/token', {",
    "      method: 'POST',",
    "      headers: { 'Content-Type': 'application/json' },",
    "      body: JSON.stringify({",
    "        grant_type: 'client_credentials',",
    "        client_id: credential.clientId,",
    "        client_secret: credential.clientSecret,",
    "      }),",
    "    })",
    "",
    "    if (!response.ok) throw new Error(`Token exchange failed (${response.status})`)",
    "    const data = await response.json() as { access_token: string; expires_in?: number }",
    "    this.accessToken = data.access_token",
    "    this.tokenExpiresAt = Date.now() + (data.expires_in ?? 900) * 1000",
    "    return this.accessToken",
    "  }",
    "",
    "  async discover(ctx: AdapterContext): Promise<unknown> {",
    "    const token = await this.getAccessToken(ctx)",
    "    const res = await ctx.fetch('https://api.example.com/info', {",
    "      headers: { Authorization: `Bearer ${token}` },",
    "    })",
    "    return res.json()",
    "  }",
    "",
    "  async query(request: Record<string, unknown>, ctx: AdapterContext): Promise<unknown> {",
    "    const token = await this.getAccessToken(ctx)",
    "    const res = await ctx.fetch('https://api.example.com/search', {",
    "      method: 'POST',",
    "      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },",
    "      body: JSON.stringify(request),",
    "    })",
    "    return res.json()",
    "  }",
    "",
    "  async execute(",
    "    request: Record<string, unknown>,",
    "    options: ExecuteOptions | undefined,",
    "    ctx: AdapterContext,",
    "  ): Promise<unknown> {",
    "    const token = await this.getAccessToken(ctx)",
    "    const res = await ctx.fetch('https://api.example.com/action', {",
    "      method: 'POST',",
    "      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },",
    "      body: JSON.stringify(request),",
    "    })",
    "    return res.json()",
    "  }",
    "}",
    "```",
    "OAuth2 adapter manifest example:",
    "```typescript",
    "export const manifest = defineManifest({",
    "  platform: 'github-issues',",
    "  auth: {",
    "    type: 'oauth2',",
    "    strategy: 'bearer',",
    "    scopes: ['repo', 'read:user'],",
    "    oauth: {",
    "      oauthService: 'github',",
    "      authorizationUrl: 'https://github.com/login/oauth/authorize',",
    "      tokenUrl: 'https://github.com/login/oauth/access_token',",
    "      tokenContentType: 'form',",
    "    },",
    "  },",
    "  authenticatedDomains: ['api.github.com'],",
    "  allowedDomains: [],",
    "});",
    "```",
    params.previousErrors
      ? `Previous attempt errors (fix these):\n${params.previousErrors}`
      : "",
    "Return exactly this format:",
    "===INTERACTION_PROFILE_JSON===",
    "{...valid JSON...}",
    "===ADAPTER_TYPESCRIPT===",
    "...valid TypeScript...",
    "===END===",
    "Reference: adapter API barrel exports",
    params.fewShot.adapterApi,
    "Reference: dynamic adapter example",
    params.fewShot.referenceAdapter,
    "Reference: interaction profile example",
    params.fewShot.referenceInteractionProfile,
    "LLM analysis summary",
    params.analysisSummary,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatFindingsSection(label: string, items: string[]): string {
  if (items.length === 0) {
    return `${label}:\n- None found`;
  }

  return `${label}:\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function buildAnalysisSummary(findings: DiscoveryFindings, pagesVisited: number, toolCalls: number): string {
  const sections = [
    `Discovery stats: pagesVisited=${pagesVisited}, toolCalls=${toolCalls}`,
  ];
  for (const [category, items] of Object.entries(findings)) {
    if (items.length > 0) {
      const label = category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      sections.push(formatFindingsSection(label, items));
    }
  }
  return sections.join("\n\n");
}

function parseGeneratedArtifacts(raw: string): GeneratedArtifacts {
  const profileStart = "===INTERACTION_PROFILE_JSON===";
  const adapterStart = "===ADAPTER_TYPESCRIPT===";
  const endMarker = "===END===";

  const profileIndex = raw.indexOf(profileStart);
  const adapterIndex = raw.indexOf(adapterStart);
  const endIndex = raw.indexOf(endMarker);

  if (profileIndex >= 0 && adapterIndex > profileIndex) {
    const profileText = raw
      .slice(profileIndex + profileStart.length, adapterIndex)
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    const adapterText = raw
      .slice(adapterIndex + adapterStart.length, endIndex > adapterIndex ? endIndex : undefined)
      .trim()
      .replace(/^```(?:ts|typescript)?\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    if (!profileText || !adapterText) {
      throw new Error("LLM output markers found, but profile or adapter content was empty.");
    }

    return {
      interactionProfileJson: profileText,
      adapterTypescript: `${adapterText}\n`,
    };
  }

  const jsonFence = raw.match(/```json\s*([\s\S]*?)```/i);
  const tsFence = raw.match(/```(?:ts|typescript)\s*([\s\S]*?)```/i);

  if (jsonFence?.[1] && tsFence?.[1]) {
    return {
      interactionProfileJson: jsonFence[1].trim(),
      adapterTypescript: `${tsFence[1].trim()}\n`,
    };
  }

  throw new Error("Could not parse generated artifacts from model output.");
}

function normalizeInteractionProfile(rawProfile: string, platformSlug: string): string {
  const parsed = interactionProfileSchema.parse(JSON.parse(rawProfile));
  const normalized = {
    ...parsed,
    platform: platformSlug,
    method: "ai-generated" as const,
    generated: new Date().toISOString().slice(0, 10),
  };

  return `${JSON.stringify(normalized, null, 2)}\n`;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function normalizePathForMatch(value: string): string {
  return value.replace(/\\/g, "/");
}

function extractDiagnosticFile(line: string): string | null {
  const byParen = line.match(/^(.+)\(\d+,\d+\):\s+error\sTS\d+:/);
  if (byParen?.[1]) return byParen[1].trim();

  const byDash = line.match(/^(.+):\d+:\d+\s+-\s+error\sTS\d+:/);
  if (byDash?.[1]) return byDash[1].trim();

  return null;
}

function hasTypeScriptDiagnostic(line: string): boolean {
  return /\berror\s+TS\d+:/.test(line);
}

export interface TypecheckOutputAnalysis {
  hasTypeScriptDiagnostics: boolean;
  hasAdapterDiagnostics: boolean;
  filteredOutput: string;
  rawOutput: string;
}

export interface TypecheckResult extends TypecheckOutputAnalysis {
  ok: boolean;
  exitCode: number;
  output: string;
}

export function analyzeTypecheckOutputForAdapter(
  output: string,
  projectRoot: string,
  adapterPath: string,
): TypecheckOutputAnalysis {
  const rawOutput = output.trim();
  if (!rawOutput) {
    return {
      hasTypeScriptDiagnostics: false,
      hasAdapterDiagnostics: false,
      filteredOutput: "",
      rawOutput: "",
    };
  }

  const lines = rawOutput.split(/\r?\n/g);
  const adapterRelative = normalizePathForMatch(path.relative(projectRoot, adapterPath));
  const adapterAbsolute = normalizePathForMatch(path.resolve(projectRoot, adapterPath));
  const filtered: string[] = [];
  let hasTypeScriptDiagnostics = false;
  let hasAdapterDiagnostics = false;
  let includeCurrentDiagnostic = false;

  for (const line of lines) {
    const cleanLine = stripAnsi(line);
    const isTypeScriptDiagnostic = hasTypeScriptDiagnostic(cleanLine);
    if (isTypeScriptDiagnostic) {
      hasTypeScriptDiagnostics = true;
    }
    const diagnosticFile = extractDiagnosticFile(cleanLine);

    if (diagnosticFile) {
      const normalizedFile = normalizePathForMatch(path.resolve(projectRoot, diagnosticFile));
      includeCurrentDiagnostic =
        normalizedFile === adapterAbsolute ||
        normalizedFile.endsWith(`/${adapterRelative}`) ||
        normalizePathForMatch(diagnosticFile).endsWith(adapterRelative);
      if (includeCurrentDiagnostic && isTypeScriptDiagnostic) {
        hasAdapterDiagnostics = true;
      }
    }

    if (includeCurrentDiagnostic) {
      filtered.push(line);
    }
  }

  let filteredOutput = "";
  if (filtered.length > 0) {
    filteredOutput = filtered.join("\n").trim();
  } else if (hasTypeScriptDiagnostics) {
    filteredOutput = `Type-check failed, but no errors were reported in generated adapter '${adapterRelative}'.`;
  } else {
    filteredOutput = rawOutput;
  }

  return {
    hasTypeScriptDiagnostics,
    hasAdapterDiagnostics,
    filteredOutput,
    rawOutput,
  };
}

export function shouldAcceptTypecheckResult(result: TypecheckResult): boolean {
  if (result.ok) return true;
  return result.hasTypeScriptDiagnostics && !result.hasAdapterDiagnostics;
}

function runTypecheck(projectRoot: string, adapterPath: string): TypecheckResult {
  const result = Bun.spawnSync(["bun", "run", "typecheck"], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  const stderr = Buffer.from(result.stderr).toString("utf8").trim();
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  const analysis = analyzeTypecheckOutputForAdapter(combined, projectRoot, adapterPath);
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : 1;
  const output = analysis.filteredOutput || analysis.rawOutput;

  return {
    ok: exitCode === 0,
    exitCode,
    output,
    ...analysis,
  };
}

function ensureParentDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeArtifacts(adapterPath: string, profilePath: string, artifacts: GeneratedArtifacts, platformSlug: string): string {
  ensureParentDirectory(adapterPath);
  ensureParentDirectory(profilePath);

  const normalizedProfile = normalizeInteractionProfile(artifacts.interactionProfileJson, platformSlug);
  fs.writeFileSync(profilePath, normalizedProfile, "utf8");
  fs.writeFileSync(adapterPath, artifacts.adapterTypescript, "utf8");
  return normalizedProfile;
}

function truncateForPrompt(text: string, maxChars = 12_000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function canPromptForCacheChoice(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptForCachedDiscoveryUse(platformName: string, ageMs: number): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(
      `[cache] Found cached discovery for '${platformName}' (${formatCacheAge(ageMs)} old). Use cache? [Y/n] `,
    );
    const normalized = answer.trim().toLowerCase();
    if (!normalized || normalized === "y" || normalized === "yes") return true;
    if (normalized === "n" || normalized === "no") return false;
    return true;
  } finally {
    rl.close();
  }
}

function fromCachedDiscovery(cache: {
  findings: DiscoveryFindings;
  pagesVisited: number;
  toolCalls: number;
  sourceUrls: string[];
}): DiscoveryResult {
  return {
    findings: cache.findings,
    pagesVisited: cache.pagesVisited,
    toolCalls: cache.toolCalls,
    sourceUrls: cache.sourceUrls,
  };
}

export async function runGeneration(
  options: GenerationOptions,
  log: (message: string) => void,
): Promise<GenerationResult> {
  const showThinking = options.showThinking ?? true;
  const showTextStream = options.verbose ?? false;
  const thinkingPrefix = "\x1b[2;90m";
  const textPrefix = "\x1b[37m";
  const ansiReset = "\x1b[0m";
  let thinkingLineOpen = false;
  let textLineOpen = false;
  const writeThinking = (text: string) => {
    if (!showThinking || !text) return;
    if (textLineOpen) {
      process.stderr.write("\n");
      textLineOpen = false;
    }
    process.stderr.write(`${thinkingPrefix}${text}${ansiReset}`);
    thinkingLineOpen = !text.endsWith("\n");
  };
  const writeText = (text: string) => {
    if (!showTextStream || !text) return;
    if (thinkingLineOpen) {
      process.stderr.write("\n");
      thinkingLineOpen = false;
    }
    process.stderr.write(`${textPrefix}${text}${ansiReset}`);
    textLineOpen = !text.endsWith("\n");
  };
  const endThinkingLine = () => {
    if (!showThinking || !thinkingLineOpen) return;
    process.stderr.write("\n");
    thinkingLineOpen = false;
  };
  const endTextLine = () => {
    if (!showTextStream || !textLineOpen) return;
    process.stderr.write("\n");
    textLineOpen = false;
  };

  const config = loadConfig();
  let runtime = await resolveLlmRuntime(config, {
    provider: options.providerOverride,
    model: options.modelOverride,
  });
  const debug = (message: string) => {
    if (options.verbose) {
      log(`[debug] ${message}`);
    }
  };
  const refreshRuntime = async () => {
    runtime = await resolveLlmRuntime(config, {
      provider: options.providerOverride,
      model: options.modelOverride,
    });
    log(`Refreshed credentials. Using provider '${runtime.provider}' (${runtime.source}) with model '${runtime.model}'.`);
  };

  const platformSlug = slugifyPlatformName(options.platformName);
  if (!platformSlug) {
    throw new Error("Platform name resolved to an empty slug. Use a name with letters or numbers.");
  }

  const adapterClassName = `${toPascalCase(platformSlug)}Adapter`;
  const projectRoot = resolveProjectRoot();
  const adapterPath = resolveAdapterOutputPath(projectRoot, platformSlug, options.adapterOutputPath);
  const profilePath = resolveInteractionProfilePath(platformSlug);
  const adapterApiImportPath = ADAPTER_API_IMPORT_ALIAS;
  const adapterFilePathHint = normalizePathForPrompt(path.relative(projectRoot, adapterPath) || adapterPath);
  const llmOverrides: ConfigOverrides = {
    provider: options.providerOverride,
    model: options.modelOverride,
  };
  const docsUsed: SearchResult[] = options.docsUrl
    ? [{ title: `${options.platformName} documentation`, url: options.docsUrl }]
    : [];

  log(`Using provider '${runtime.provider}' (${runtime.source}) with model '${runtime.model}'.`);
  const cachePath = resolveDiscoveryCachePath(platformSlug);
  const cacheFileExists = fs.existsSync(cachePath);
  const cachedDiscovery = readDiscoveryCache(platformSlug);
  if (cacheFileExists && !cachedDiscovery && !options.skipDiscovery) {
    log(`[cache] Ignoring invalid discovery cache at '${cachePath}'; running fresh discovery.`);
  }

  let discoverySource: "cache" | "fresh" = "fresh";
  let discoveryResult: DiscoveryResult | undefined;

  if (options.skipDiscovery) {
    let requiredCache;
    try {
      requiredCache = readDiscoveryCache(platformSlug, { required: true });
    } catch (error) {
      if (error instanceof DiscoveryCacheReadError) {
        throw new Error(error.message);
      }
      throw error;
    }

    if (!requiredCache) {
      throw new Error(`No discovery cache found for '${platformSlug}' at '${cachePath}'.`);
    }

    discoverySource = "cache";
    discoveryResult = fromCachedDiscovery(requiredCache.cache);
    log(`[cache] Using cached discovery for '${options.platformName}' (${formatCacheAge(requiredCache.ageMs)} old).`);
  }

  if (!discoveryResult) {
    let runFreshDiscovery = true;

    if (options.rediscover) {
      log(`[cache] --rediscover enabled; running fresh discovery for '${options.platformName}'.`);
    } else if (cachedDiscovery && isFreshDiscoveryCache(cachedDiscovery.ageMs)) {
      if (canPromptForCacheChoice()) {
        const useCache = await promptForCachedDiscoveryUse(options.platformName, cachedDiscovery.ageMs);
        if (useCache) {
          discoverySource = "cache";
          discoveryResult = fromCachedDiscovery(cachedDiscovery.cache);
          runFreshDiscovery = false;
          log(`[cache] Using cached discovery for '${options.platformName}' (${formatCacheAge(cachedDiscovery.ageMs)} old).`);
        } else {
          log(`[cache] User selected rediscovery for '${options.platformName}'.`);
        }
      } else {
        discoverySource = "cache";
        discoveryResult = fromCachedDiscovery(cachedDiscovery.cache);
        runFreshDiscovery = false;
        log(`[cache] Using cached discovery for '${options.platformName}' (${formatCacheAge(cachedDiscovery.ageMs)} old).`);
      }
    } else if (cachedDiscovery) {
      log(
        `[cache] Cached discovery for '${options.platformName}' is stale (${formatCacheAge(cachedDiscovery.ageMs)} old); running fresh discovery.`,
      );
    }

    if (runFreshDiscovery) {
      log(`Running agentic API discovery for '${options.platformName}'...`);
      const discoveryStartedAtMs = Date.now();
      let freshDiscoveryResult: DiscoveryResult | undefined;

      for (let discoveryAttempt = 1; discoveryAttempt <= 2; discoveryAttempt++) {
        try {
          freshDiscoveryResult = await runDiscoveryAgent({
            platformName: options.platformName,
            docsUrl: options.docsUrl,
            runtimeProvider: runtime.provider,
            runtimeModel: runtime.model,
            config,
            overrides: llmOverrides,
            writeThinking,
          });
          break;
        } catch (error) {
          if (isLlmAuthError(error) && discoveryAttempt === 1) {
            log("Authentication error during discovery; refreshing credentials and retrying.");
            await refreshRuntime();
            continue;
          }

          throw error;
        }
      }

      if (!freshDiscoveryResult) {
        throw new Error("Discovery agent did not return results.");
      }

      discoverySource = "fresh";
      discoveryResult = freshDiscoveryResult;

      const discoveryDurationMs = Math.max(0, Date.now() - discoveryStartedAtMs);
      const docsUrl = options.docsUrl?.trim();
      writeDiscoveryCache(platformSlug, {
        version: 1,
        platformName: options.platformName,
        platformSlug,
        generatedAt: new Date().toISOString(),
        model: runtime.model,
        provider: runtime.provider,
        durationMs: discoveryDurationMs,
        sourceUrls: Array.from(new Set(discoveryResult.sourceUrls.map((url) => url.trim()).filter(Boolean))).sort((a, b) =>
          a.localeCompare(b),
        ),
        ...(docsUrl ? { docsUrl } : {}),
        pagesVisited: discoveryResult.pagesVisited,
        toolCalls: discoveryResult.toolCalls,
        findings: discoveryResult.findings,
      });
      log(`[cache] Saved discovery findings to '${cachePath}'.`);
    }
  }

  if (!discoveryResult) {
    throw new Error("Discovery agent did not return results.");
  }

  debug(
    `Discovery complete (${discoverySource}): ${discoveryResult.toolCalls} tool calls, ${discoveryResult.pagesVisited} pages visited.`,
  );
  const analysisSummary = buildAnalysisSummary(
    discoveryResult.findings,
    discoveryResult.pagesVisited,
    discoveryResult.toolCalls,
  );

  const fewShot = readFewShotContext();
  debug("Loaded few-shot adapter/profile reference context.");
  endThinkingLine();
  endTextLine();

  let previousErrors: string | undefined;
  let lastError = "Unknown generation failure";
  const currentDate = new Date().toISOString().slice(0, 10);

  for (let attempt = 1; attempt <= config.generation.maxIterations; attempt++) {
    log(`Generation attempt ${attempt}/${config.generation.maxIterations}...`);

    try {
      if (attempt > 1) {
        debug("Retry attempt: using findings summary + few-shot + error feedback.");
      }
      const generationPrompt = buildGenerationPrompt({
        platformName: options.platformName,
        platformSlug,
        adapterClassName,
        adapterFilePathHint,
        adapterApiImportPath,
        analysisSummary,
        fewShot,
        currentDate,
        previousErrors,
      });

      let raw = "";
      try {
        raw = await streamPrompt(runtime, generationPrompt, {
          temperature: 0.1,
          maxTokens: 16_000,
          onThinking: writeThinking,
          onText: () => {},
        });
      } finally {
        endThinkingLine();
        endTextLine();
      }

      const artifacts = parseGeneratedArtifacts(raw);
      const normalizedInteractionProfile = writeArtifacts(adapterPath, profilePath, artifacts, platformSlug);

      const syncBusinessProfile = () =>
        syncGeneratedBusinessToUserProfile({
          projectRoot,
          platformName: options.platformName,
          platformSlug,
          findings: discoveryResult.findings,
          sourceUrls: discoveryResult.sourceUrls,
          adapterSource: artifacts.adapterTypescript,
          interactionProfileJson: normalizedInteractionProfile,
        });

      if (!config.generation.autoVerify) {
        log("Warning: review the generated adapter/profile before running it against real accounts.");
        const businessProfileUpdate = syncBusinessProfile();
        return {
          adapterPath,
          profilePath,
          attempts: attempt,
          docsUsed,
          runtime,
          businessProfileUpdate,
        };
      }

      const typecheck = runTypecheck(projectRoot, adapterPath);
      if (shouldAcceptTypecheckResult(typecheck)) {
        if (typecheck.ok) {
          log("Type-check passed.");
        } else {
          log("Type-check passed for generated adapter; unrelated TypeScript diagnostics were ignored.");
        }
        log("Warning: review the generated adapter/profile before running it against real accounts.");
        const businessProfileUpdate = syncBusinessProfile();
        return {
          adapterPath,
          profilePath,
          attempts: attempt,
          docsUsed,
          runtime,
          businessProfileUpdate,
        };
      }

      lastError = typecheck.output || typecheck.rawOutput || "Type-check failed with no output.";
      previousErrors = truncateForPrompt(lastError);
      log(`Type-check failed on attempt ${attempt}; retrying with error feedback.`);
    } catch (error) {
      if (isLlmAuthError(error)) {
        log("Authentication error from LLM provider; refreshing credentials and retrying.");
        await refreshRuntime();
        previousErrors = undefined;
        lastError = "Authentication error while generating artifacts.";
        continue;
      }

      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      previousErrors = truncateForPrompt(message);
      log(`Attempt ${attempt} failed: ${message}`);
    }
  }

  throw new Error(
    `Generation failed after ${config.generation.maxIterations} attempts. Last error: ${lastError}`,
  );
}
