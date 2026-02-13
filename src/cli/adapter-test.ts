import path from "node:path";

import type { AgpAdapter } from "../adapters/adapter";
import { AdapterContext } from "../adapters/context";
import type { AdapterManifest } from "../adapters/manifest";
import { AdapterRegistry, type AdapterFactory } from "../core/adapter-registry";
import { ProfileStore } from "../store/profile-store";
import type { BusinessProfile } from "../types/profile";
import { resolveProjectRoot } from "./paths";

type UnknownRecord = Record<string, unknown>;

interface TestableAdapter extends AgpAdapter {
  testExecuteParams?: () =>
    | Record<string, unknown>
    | null
    | Promise<Record<string, unknown> | null>;
}

interface AdapterDescriptor {
  slug: string;
  source: string;
  factory: AdapterFactory;
  manifest?: AdapterManifest;
}

interface ConfiguredAdapterTarget {
  business: BusinessProfile;
  adapter: AdapterDescriptor;
}

interface ParsedTestArgs {
  list: boolean;
  platform: string | null;
  verbose: boolean;
  includeExecute: boolean;
}

type OperationName = "discover" | "query" | "execute";
type OperationStatus = "passed" | "failed" | "skipped";

interface OperationOutcome {
  operation: OperationName;
  status: OperationStatus;
  summary: string;
  attempted: boolean;
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

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function removeTrailingDigits(value: string): string {
  const trimmed = value.replace(/[0-9]+$/g, "");
  return trimmed || value;
}

function profilePathFromEnvOrDefault(projectRoot: string): string {
  const envPath = process.env.AGENR_USER_PROFILE_PATH;
  if (envPath && envPath.trim()) {
    const normalized = envPath.trim();
    return path.isAbsolute(normalized) ? normalized : path.resolve(projectRoot, normalized);
  }

  return path.join(projectRoot, "data", "user-profile.json");
}

async function discoverAdapters(): Promise<AdapterDescriptor[]> {
  const registry = new AdapterRegistry();
  await registry.loadDynamicAdapters();

  return registry.listEntries().map((entry) => ({
    slug: entry.platform,
    source: entry.source,
    factory: entry.factory,
    manifest: entry.manifest,
  }));
}

function createTestContext(platform: string, manifest?: AdapterManifest): AdapterContext {
  return new AdapterContext({
    platform,
    userId: "adapter-test",
    executionId: crypto.randomUUID(),
    manifest: manifest ?? {
      platform,
      auth: {
        type: "none",
        strategy: "none",
      },
      authenticatedDomains: [],
      allowedDomains: [],
    },
    resolveCredential: async (_options) => null,
  });
}

function resolveAdapterForBusiness(
  business: BusinessProfile,
  adapters: AdapterDescriptor[],
): AdapterDescriptor | null {
  const platformSlug = slugify(business.platform);
  const strippedPlatformSlug = removeTrailingDigits(platformSlug);
  const businessIdSlug = slugify(business.id);

  const keysInPriorityOrder = [platformSlug, strippedPlatformSlug, businessIdSlug];
  for (const key of keysInPriorityOrder) {
    const match = adapters.find((entry) => entry.slug === key);
    if (match) return match;
  }

  return null;
}

function loadConfiguredTargets(
  profilePath: string,
  adapters: AdapterDescriptor[],
): ConfiguredAdapterTarget[] {
  const profileStore = new ProfileStore(profilePath);
  const businesses = profileStore.getUserProfile().businesses;

  const configured: ConfiguredAdapterTarget[] = [];
  for (const business of businesses) {
    const adapter = resolveAdapterForBusiness(business, adapters);
    if (!adapter) continue;
    configured.push({ business, adapter });
  }

  return configured;
}

function parseArgs(args: string[]): ParsedTestArgs {
  let list = false;
  let verbose = false;
  let includeExecute = false;
  const platformParts: string[] = [];

  for (const arg of args) {
    if (arg === "--list") {
      list = true;
      continue;
    }

    if (arg === "--verbose") {
      verbose = true;
      continue;
    }

    if (arg === "--include-execute") {
      includeExecute = true;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag '${arg}'.`);
    }

    platformParts.push(arg);
  }

  const platform = platformParts.join(" ").trim() || null;

  if (list && platform) {
    throw new Error("Usage: agenr test --list");
  }

  if (!list && !platform) {
    throw new Error("Usage: agenr test <platform> [--verbose] [--include-execute] or agenr test --list");
  }

  return { list, platform, verbose, includeExecute };
}

function printConfiguredTargets(targets: ConfiguredAdapterTarget[], profilePath: string): void {
  if (targets.length === 0) {
    console.log(`No configured testable adapters found in '${profilePath}'.`);
    return;
  }

  console.log("Configured testable adapters:");
  for (const target of targets) {
    const adapterLabel = path.basename(target.adapter.source);
    console.log(
      `- ${target.adapter.slug} (businessId=${target.business.id}, platform=${target.business.platform}, adapter=${adapterLabel})`,
    );
  }
}

function resolveTargetOrThrow(
  rawTarget: string,
  configuredTargets: ConfiguredAdapterTarget[],
  allAdapters: AdapterDescriptor[],
  profilePath: string,
): ConfiguredAdapterTarget {
  const normalized = slugify(rawTarget);
  const candidates = configuredTargets.filter((target) => {
    const businessId = slugify(target.business.id);
    const platform = slugify(target.business.platform);
    const platformWithoutDigits = removeTrailingDigits(platform);
    const adapterSlug = target.adapter.slug;
    return (
      normalized === businessId ||
      normalized === platform ||
      normalized === platformWithoutDigits ||
      normalized === adapterSlug
    );
  });

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length > 1) {
    const ids = candidates.map((candidate) => candidate.business.id).sort((a, b) => a.localeCompare(b));
    throw new Error(
      `Ambiguous platform '${rawTarget}'. Matches businesses: ${ids.join(", ")}. Use a specific business id.`,
    );
  }

  const adapterExists = allAdapters.some((adapter) => adapter.slug === normalized);
  if (adapterExists) {
    throw new Error(
      `Adapter '${rawTarget}' exists but no matching business is configured in '${profilePath}'. Add a business with matching id/platform.`,
    );
  }

  const available = configuredTargets
    .map((target) => `${target.business.id}(${target.business.platform})`)
    .sort((a, b) => a.localeCompare(b));

  throw new Error(
    available.length > 0
      ? `Unknown platform '${rawTarget}'. Configured targets: ${available.join(", ")}.`
      : `Unknown platform '${rawTarget}'. No configured testable adapters found in '${profilePath}'.`,
  );
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function assertNoTopLevelError(payload: UnknownRecord): void {
  const maybeError = payload["error"];
  if (typeof maybeError === "string" && maybeError.trim()) {
    throw new Error(maybeError.trim());
  }
}

function summarizeDiscover(response: UnknownRecord): string {
  const business = toRecord(response["business"]);
  const businessName =
    readString(business["name"]) ??
    readString(business["id"]) ??
    readString(business["platform"]) ??
    "business";
  const accountId =
    readString(business["accountId"]) ??
    readString(business["merchantId"]) ??
    readString(business["id"]);
  const mode = readString(business["mode"]) ?? readString(business["environment"]);
  const currency = readString(business["defaultCurrency"]);

  const parts: string[] = [businessName];
  if (accountId && accountId !== businessName) {
    parts.push(`(${accountId})`);
  }
  if (mode) {
    parts.push(`${mode} mode`);
  }
  if (currency) {
    parts.push(currency.toUpperCase());
  }

  return parts.join(", ");
}

function findFirstNonEmptyTopLevelArray(response: UnknownRecord): unknown[] {
  for (const value of Object.values(response)) {
    if (Array.isArray(value) && value.length > 0) {
      return value;
    }
  }

  return [];
}

function resolveQueryItems(response: UnknownRecord): unknown[] {
  const items = response["items"];
  if (Array.isArray(items) && items.length > 0) return items;

  const services = response["services"];
  if (Array.isArray(services) && services.length > 0) return services;

  return findFirstNonEmptyTopLevelArray(response);
}

function collectSampleNames(rows: unknown[], maxSamples = 3): string[] {
  const samples: string[] = [];

  for (const row of rows) {
    if (samples.length >= maxSamples) break;
    const record = toRecord(row);
    const name =
      readString(record["name"]) ??
      readString(record["title"]) ??
      readString(record["id"]) ??
      readString(record["guid"]);
    if (!name) continue;
    samples.push(name);
  }

  return samples;
}

function summarizeQuery(response: UnknownRecord): string {
  const rows = resolveQueryItems(response);
  const samples = collectSampleNames(rows);
  const base = `${rows.length} item${rows.length === 1 ? "" : "s"} found`;
  if (samples.length === 0) return base;
  return `${base} (${samples.join(", ")})`;
}

function validateDiscoverOrThrow(response: unknown): UnknownRecord {
  const record = toRecord(response);
  assertNoTopLevelError(record);

  const business = toRecord(record["business"]);
  const hasIdentifier =
    Boolean(readString(business["name"])) ||
    Boolean(readString(business["id"])) ||
    Boolean(readString(business["platform"]));

  if (!hasIdentifier) {
    throw new Error("discover response missing business info (expected business.name, business.id, or business.platform)");
  }

  return record;
}

function validateQueryOrThrow(response: unknown): UnknownRecord {
  const record = toRecord(response);
  assertNoTopLevelError(record);

  const rows = resolveQueryItems(record);
  if (rows.length === 0) {
    throw new Error("query response did not include any non-empty result arrays");
  }

  return record;
}

function validateExecuteOrThrow(response: unknown): UnknownRecord {
  const record = toRecord(response);
  assertNoTopLevelError(record);
  return record;
}

function statusPrefix(status: OperationStatus): string {
  if (status === "passed") return "✓";
  if (status === "failed") return "✗";
  return "⊘";
}

function printOutcome(outcome: OperationOutcome): void {
  const label = outcome.operation.padEnd(8, " ");
  console.log(`${statusPrefix(outcome.status)} ${label} - ${outcome.summary}`);
}

function defaultQueryRequestFor(target: ConfiguredAdapterTarget): Record<string, unknown> {
  const platformSlug = removeTrailingDigits(slugify(target.business.platform));
  const adapterSlug = target.adapter.slug;

  if (adapterSlug === "stripe" || platformSlug === "stripe") {
    return { resource: "products", limit: 10, active: true };
  }

  if (adapterSlug === "toast" || platformSlug === "toast") {
    return { type: "menu", limit: 10 };
  }

  if (adapterSlug === "factor" || platformSlug === "factor") {
    return {};
  }

  return {};
}

function detectStripeMode(discoverResponse: UnknownRecord | null): "test" | "live" | null {
  if (!discoverResponse) return null;
  const business = toRecord(discoverResponse["business"]);
  const mode = readString(business["mode"]);
  if (mode === "test" || mode === "live") return mode;
  return null;
}

async function resolveExecuteParams(
  adapter: TestableAdapter,
  target: ConfiguredAdapterTarget,
  discoverResponse: UnknownRecord | null,
): Promise<{ params: Record<string, unknown> | null; skipReason: string | null }> {
  const adapterSlug = target.adapter.slug;
  const normalizedPlatform = removeTrailingDigits(slugify(target.business.platform));
  const isStripe = adapterSlug === "stripe" || normalizedPlatform === "stripe";

  if (isStripe) {
    const mode = detectStripeMode(discoverResponse);
    if (mode !== "test") {
      if (mode === "live") {
        return { params: null, skipReason: "skipped (Stripe account is in live mode)" };
      }
      return { params: null, skipReason: "skipped (could not confirm Stripe test mode from discover result)" };
    }
  }

  if (typeof adapter.testExecuteParams === "function") {
    const params = await adapter.testExecuteParams();
    if (params && Object.keys(params).length > 0) {
      return { params, skipReason: null };
    }
  }

  if (isStripe) {
    return {
      params: {
        amount: 100,
        currency: "usd",
        confirm: false,
        automaticPaymentMethods: true,
      },
      skipReason: null,
    };
  }

  return { params: null, skipReason: "skipped (no safe execute test configured for this adapter)" };
}

async function runOperation(
  operation: OperationName,
  execute: () => Promise<unknown>,
  validator: (payload: unknown) => UnknownRecord,
  summarizer: (payload: UnknownRecord) => string,
  verbose: boolean,
): Promise<{ outcome: OperationOutcome; payload: UnknownRecord | null }> {
  try {
    const raw = await execute();
    if (verbose) {
      console.log(`${operation} response:\n${formatJson(raw)}`);
    }
    const validated = validator(raw);

    return {
      outcome: {
        operation,
        status: "passed",
        summary: summarizer(validated),
        attempted: true,
      },
      payload: validated,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: {
        operation,
        status: "failed",
        summary: message,
        attempted: true,
      },
      payload: null,
    };
  }
}

export async function runAdapterTestCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  const projectRoot = resolveProjectRoot();
  const adapters = await discoverAdapters();
  const profilePath = profilePathFromEnvOrDefault(projectRoot);

  let configuredTargets: ConfiguredAdapterTarget[];
  try {
    configuredTargets = loadConfiguredTargets(profilePath, adapters);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load profile from '${profilePath}'. Ensure the file exists and is valid JSON. (${message})`,
    );
  }

  if (parsed.list) {
    printConfiguredTargets(configuredTargets, profilePath);
    return 0;
  }

  const target = resolveTargetOrThrow(parsed.platform ?? "", configuredTargets, adapters, profilePath);
  const adapterName = target.adapter.slug;
  console.log(`Testing ${adapterName} adapter...`);

  let adapterInstance: TestableAdapter;
  const ctx = createTestContext(target.business.platform, target.adapter.manifest);
  try {
    adapterInstance = target.adapter.factory(target.business, ctx) as TestableAdapter;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to initialize adapter: ${message}`);
    return 1;
  }

  const outcomes: OperationOutcome[] = [];

  const discoverResult = await runOperation(
    "discover",
    () => adapterInstance.discover(ctx),
    validateDiscoverOrThrow,
    summarizeDiscover,
    parsed.verbose,
  );
  outcomes.push(discoverResult.outcome);
  printOutcome(discoverResult.outcome);

  const queryRequest = defaultQueryRequestFor(target);
  const queryResult = await runOperation(
    "query",
    () => adapterInstance.query(queryRequest, ctx),
    validateQueryOrThrow,
    summarizeQuery,
    parsed.verbose,
  );
  outcomes.push(queryResult.outcome);
  printOutcome(queryResult.outcome);

  if (!parsed.includeExecute) {
    const skipped: OperationOutcome = {
      operation: "execute",
      status: "skipped",
      summary: "skipped (use --include-execute)",
      attempted: false,
    };
    outcomes.push(skipped);
    printOutcome(skipped);
  } else {
    const executeParams = await resolveExecuteParams(adapterInstance, target, discoverResult.payload);
    if (!executeParams.params) {
      const skipped: OperationOutcome = {
        operation: "execute",
        status: "skipped",
        summary: executeParams.skipReason ?? "skipped",
        attempted: false,
      };
      outcomes.push(skipped);
      printOutcome(skipped);
    } else {
      const executeResult = await runOperation(
        "execute",
        () => adapterInstance.execute(executeParams.params as Record<string, unknown>, undefined, ctx),
        validateExecuteOrThrow,
        () => "execute test passed",
        parsed.verbose,
      );
      outcomes.push(executeResult.outcome);
      printOutcome(executeResult.outcome);
    }
  }

  const attempted = outcomes.filter((outcome) => outcome.attempted);
  const passed = attempted.filter((outcome) => outcome.status === "passed");
  const failed = attempted.filter((outcome) => outcome.status === "failed");
  const skipped = outcomes.filter((outcome) => outcome.status === "skipped");

  console.log("");
  console.log(`${passed.length}/${attempted.length} passed, ${skipped.length} skipped`);

  return failed.length > 0 ? 1 : 0;
}
