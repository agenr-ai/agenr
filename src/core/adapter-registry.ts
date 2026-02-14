import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  deleteAdapterById,
  getBundledAdapterState,
  getAdaptersWithSource,
  listActiveAdapters,
  seedBundledAdapter,
  type AdapterRecord,
  updateBundledAdapter,
} from "../db/adapters";
import { resolveAdaptersBaseDirectory, resolvePublicAdapterPath, resolveRuntimeAdaptersDirectory } from "../utils/adapter-paths";
import { logger } from "../utils/logger";
import type { AgpAdapter } from "../adapters/adapter";
import type { AdapterContext } from "../adapters/context";
import { defineManifest, type AdapterManifest, type OAuthManifestConfig } from "../adapters/manifest";
import type { BusinessProfile } from "../types/profile";

export type AdapterFactory = (business: BusinessProfile, ctx: AdapterContext) => AgpAdapter;

type AdapterMeta = Record<string, unknown>;
type AdapterSource = string;
type AdapterStatus = "public" | "sandbox";

export interface AdapterEntry {
  platform: string;
  ownerId?: string;
  status: AdapterStatus;
  factory: AdapterFactory;
  source: AdapterSource;
  meta?: AdapterMeta;
  manifest?: AdapterManifest;
}

export interface OAuthAdapterDefinition {
  platform: string;
  oauthService: string;
  name: string;
  oauth: OAuthManifestConfig;
  scopes: string[];
}

type DynamicAdapterConstructor = new (business: BusinessProfile, ctx: AdapterContext) => AgpAdapter;

const PUBLIC_SCOPE = "__public__";
const VALID_AUTH_TYPES = new Set<AdapterManifest["auth"]["type"]>([
  "oauth2",
  "api_key",
  "cookie",
  "basic",
  "client_credentials",
  "none",
]);
const VALID_TOKEN_CONTENT_TYPES = new Set(["form", "json"]);
const BUNDLED_ADAPTER_VERSION_REGEX = /defineManifest\([\s\S]*?version:\s*["']([^"']+)["']/;
const BUNDLED_ADAPTER_NAME_REGEX = /defineManifest\([\s\S]*?name:\s*["']([^"']+)["']/;
const ADAPTER_API_MODULE_URL = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "adapter-api.ts"),
).href;

interface BundledAdapterManifest {
  platform: string;
  version: string;
}

function normalizePlatform(platform: string): string {
  return platform.trim().toLowerCase();
}

function normalizeBundledPlatform(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function extractBundledManifest(sourceCode: string): BundledAdapterManifest | null {
  const nameMatch = sourceCode.match(BUNDLED_ADAPTER_NAME_REGEX);
  const versionMatch = sourceCode.match(BUNDLED_ADAPTER_VERSION_REGEX);
  if (!nameMatch || !versionMatch) {
    return null;
  }

  const platform = normalizeBundledPlatform(nameMatch[1] ?? "");
  const version = (versionMatch[1] ?? "").trim();
  if (!platform || !version) {
    return null;
  }

  return {
    platform,
    version,
  };
}

function rewriteAdapterApiSpecifier(sourceCode: string): string {
  return sourceCode.replace(/(["'])agenr:adapter-api\1/g, `"${ADAPTER_API_MODULE_URL}"`);
}

function parseSemver(version: string): [number, number, number] {
  const parts = version
    .trim()
    .split(".")
    .slice(0, 3)
    .map((part) => {
      const numeric = Number.parseInt(part, 10);
      return Number.isFinite(numeric) ? numeric : 0;
    });

  while (parts.length < 3) {
    parts.push(0);
  }

  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

export function compareSemverVersions(leftVersion: string, rightVersion: string): number {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);

  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) {
      return -1;
    }
    if (left[index] > right[index]) {
      return 1;
    }
  }

  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isAdapterConstructor(value: unknown): value is DynamicAdapterConstructor {
  if (typeof value !== "function") return false;

  const prototype = (value as { prototype?: Record<string, unknown> }).prototype;
  if (!prototype || typeof prototype !== "object") return false;

  return (
    typeof prototype["discover"] === "function" &&
    typeof prototype["query"] === "function" &&
    typeof prototype["execute"] === "function"
  );
}

function readMeta(value: unknown): AdapterMeta | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return value as AdapterMeta;
}

function readOAuthConfig(
  platform: string,
  authType: AdapterManifest["auth"]["type"],
  value: unknown,
): OAuthManifestConfig | undefined {
  if (authType !== "oauth2" || !isRecord(value)) {
    return undefined;
  }

  const authorizationUrlRaw = value["authorizationUrl"];
  const tokenUrlRaw = value["tokenUrl"];
  if (typeof authorizationUrlRaw !== "string" || typeof tokenUrlRaw !== "string") {
    return undefined;
  }

  const authorizationUrl = authorizationUrlRaw.trim();
  const tokenUrl = tokenUrlRaw.trim();
  if (!isHttpsUrl(authorizationUrl) || !isHttpsUrl(tokenUrl)) {
    return undefined;
  }

  const tokenContentTypeRaw = value["tokenContentType"];
  let tokenContentType: "form" | "json" | undefined;
  if (tokenContentTypeRaw !== undefined) {
    if (
      typeof tokenContentTypeRaw !== "string" ||
      !VALID_TOKEN_CONTENT_TYPES.has(tokenContentTypeRaw)
    ) {
      return undefined;
    }
    tokenContentType = tokenContentTypeRaw as "form" | "json";
  }

  const oauthServiceRaw = value["oauthService"];
  let oauthService: string | undefined;
  if (oauthServiceRaw !== undefined) {
    if (typeof oauthServiceRaw !== "string") {
      return undefined;
    }
    const normalizedService = normalizePlatform(oauthServiceRaw);
    if (!normalizedService) {
      return undefined;
    }
    oauthService = normalizedService;
  }

  const extraAuthParamsRaw = value["extraAuthParams"];
  let extraAuthParams: Record<string, string> | undefined;
  if (extraAuthParamsRaw !== undefined) {
    if (!isRecord(extraAuthParamsRaw)) {
      return undefined;
    }

    const normalizedParams: Record<string, string> = {};
    for (const [key, paramValue] of Object.entries(extraAuthParamsRaw)) {
      if (typeof paramValue !== "string") {
        return undefined;
      }
      normalizedParams[key] = paramValue;
    }
    extraAuthParams = normalizedParams;
  }

  return {
    oauthService: oauthService ?? platform,
    authorizationUrl,
    tokenUrl,
    tokenContentType,
    extraAuthParams,
  };
}

function readManifest(value: unknown): AdapterManifest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const nameRaw = value["name"];
  const name = typeof nameRaw === "string" ? nameRaw.trim() : undefined;
  const versionRaw = value["version"];
  const version = typeof versionRaw === "string" ? versionRaw.trim() : undefined;
  const descriptionRaw = value["description"];
  const description = typeof descriptionRaw === "string" ? descriptionRaw.trim() : undefined;

  const platformRaw = value["platform"];
  if (typeof platformRaw !== "string") {
    return undefined;
  }
  const platform = normalizePlatform(platformRaw);
  if (!platform) {
    return undefined;
  }

  const authenticatedDomainsRaw = value["authenticatedDomains"];
  if (!Array.isArray(authenticatedDomainsRaw)) {
    return undefined;
  }

  if (!authenticatedDomainsRaw.every((domain) => typeof domain === "string")) {
    return undefined;
  }
  const authenticatedDomains = authenticatedDomainsRaw
    .map((domain) => domain.trim())
    .filter((domain) => domain.length > 0);

  const allowedDomainsRaw = value["allowedDomains"];
  if (
    allowedDomainsRaw !== undefined &&
    (!Array.isArray(allowedDomainsRaw) || !allowedDomainsRaw.every((domain) => typeof domain === "string"))
  ) {
    return undefined;
  }

  const allowedDomains = Array.isArray(allowedDomainsRaw)
    ? allowedDomainsRaw
        .map((domain) => domain.trim())
        .filter((domain) => domain.length > 0)
    : [];

  const authRaw = value["auth"];
  if (!isRecord(authRaw)) {
    return undefined;
  }

  const typeRaw = authRaw["type"];
  if (
    typeof typeRaw !== "string" ||
    !VALID_AUTH_TYPES.has(typeRaw as AdapterManifest["auth"]["type"])
  ) {
    return undefined;
  }
  const type = typeRaw as AdapterManifest["auth"]["type"];

  const strategyRaw = authRaw["strategy"];
  if (typeof strategyRaw !== "string") {
    return undefined;
  }
  const strategy = strategyRaw as AdapterManifest["auth"]["strategy"];

  const scopesRaw = authRaw["scopes"];
  const scopes =
    Array.isArray(scopesRaw) && scopesRaw.every((scope) => typeof scope === "string")
      ? scopesRaw
          .map((scope) => scope.trim())
          .filter((scope) => scope.length > 0)
      : undefined;

  const headerNameRaw = authRaw["headerName"];
  const headerName = typeof headerNameRaw === "string" ? headerNameRaw.trim() : undefined;
  const cookieNameRaw = authRaw["cookieName"];
  const cookieName = typeof cookieNameRaw === "string" ? cookieNameRaw.trim() : undefined;
  const oauth = readOAuthConfig(platform, type, authRaw["oauth"]);

  try {
    return defineManifest({
      name: name || undefined,
      version: version || undefined,
      description: description || undefined,
      platform,
      auth: {
        type,
        strategy,
        scopes,
        headerName: headerName || undefined,
        cookieName: cookieName || undefined,
        oauth,
      },
      authenticatedDomains,
      allowedDomains,
    });
  } catch {
    return undefined;
  }
}

function toScopeKey(ownerId: string | undefined): string {
  return ownerId?.trim() || PUBLIC_SCOPE;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, Map<string, AdapterEntry>>();
  private readonly knownAdapterFingerprints = new Map<string, string>();
  private moduleReloadNonce = 0;

  constructor() {}

  register(
    platform: string,
    factory: AdapterFactory,
    source: string,
    meta?: AdapterMeta,
    manifest?: AdapterManifest,
  ): void {
    this.registerPublic(platform, factory, source, meta, manifest);
  }

  registerPublic(
    platform: string,
    factory: AdapterFactory,
    source: string,
    meta?: AdapterMeta,
    manifest?: AdapterManifest,
  ): void {
    this.storeEntry({
      platform,
      ownerId: undefined,
      status: "public",
      factory,
      source,
      meta,
      manifest,
    });
  }

  registerScoped(
    platform: string,
    ownerId: string,
    factory: AdapterFactory,
    source: string,
    meta?: AdapterMeta,
    manifest?: AdapterManifest,
  ): void {
    this.storeEntry({
      platform,
      ownerId: ownerId.trim(),
      status: "sandbox",
      factory,
      source,
      meta,
      manifest,
    });
  }

  get(platform: string): AdapterFactory | undefined {
    return this.getPublicEntry(platform)?.factory;
  }

  resolve(platform: string, ownerId?: string): AdapterFactory | undefined {
    return this.resolveEntry(platform, ownerId)?.factory;
  }

  has(platform: string): boolean {
    return this.getPublicEntry(platform) !== undefined;
  }

  unregister(platform: string): boolean {
    return this.unregisterPublic(platform);
  }

  unregisterPublic(platform: string): boolean {
    return this.deleteEntry(platform, undefined);
  }

  unregisterScoped(platform: string, ownerId: string): boolean {
    return this.deleteEntry(platform, ownerId.trim());
  }

  listPlatforms(): string[] {
    return this.listEntries().map((entry) => entry.platform);
  }

  listEntries(): AdapterEntry[] {
    return this.listEntriesByStatus("public");
  }

  listForOwner(ownerId: string): AdapterEntry[] {
    const normalizedOwner = ownerId.trim();
    const visible: AdapterEntry[] = [];

    for (const bucket of this.adapters.values()) {
      const scoped = bucket.get(normalizedOwner);
      if (scoped) {
        visible.push(scoped);
      }

      const publicEntry = bucket.get(PUBLIC_SCOPE);
      if (publicEntry) {
        visible.push(publicEntry);
      }
    }

    return visible.sort((a, b) => a.platform.localeCompare(b.platform));
  }

  listAllActive(): AdapterEntry[] {
    const all: AdapterEntry[] = [];

    for (const bucket of this.adapters.values()) {
      all.push(...bucket.values());
    }

    return all.sort((a, b) => {
      const platformCompare = a.platform.localeCompare(b.platform);
      if (platformCompare !== 0) {
        return platformCompare;
      }

      const aKey = toScopeKey(a.ownerId);
      const bKey = toScopeKey(b.ownerId);
      return aKey.localeCompare(bKey);
    });
  }

  listOAuthAdapters(): OAuthAdapterDefinition[] {
    const adapters: OAuthAdapterDefinition[] = [];

    for (const entry of this.listEntriesByStatus("public")) {
      const manifest = entry.manifest;
      if (!manifest || manifest.auth.type !== "oauth2" || !manifest.auth.oauth) {
        continue;
      }

      const oauthService = normalizePlatform(manifest.auth.oauth.oauthService ?? entry.platform);
      if (!oauthService) {
        continue;
      }

      const entryName = entry.meta?.["name"];
      const name =
        typeof entryName === "string" && entryName.trim().length > 0
          ? entryName.trim()
          : entry.platform;

      adapters.push({
        platform: entry.platform,
        oauthService,
        name,
        oauth: {
          ...manifest.auth.oauth,
          oauthService,
        },
        scopes: manifest.auth.scopes ?? [],
      });
    }

    return adapters;
  }

  getOAuthAdapter(service: string): OAuthAdapterDefinition | null {
    const normalized = normalizePlatform(service);
    if (!normalized) {
      return null;
    }

    const adapters = this.listOAuthAdapters();
    const byService = adapters.find((entry) => entry.oauthService === normalized);
    if (byService) {
      return byService;
    }

    return adapters.find((entry) => entry.platform === normalized) ?? null;
  }

  getPublicEntry(platform: string): AdapterEntry | undefined {
    return this.getBucket(platform)?.get(PUBLIC_SCOPE);
  }

  getScopedEntry(platform: string, ownerId: string): AdapterEntry | undefined {
    return this.getBucket(platform)?.get(ownerId.trim());
  }

  resolveEntry(platform: string, ownerId?: string): AdapterEntry | undefined {
    const bucket = this.getBucket(platform);
    if (!bucket) {
      return undefined;
    }

    const normalizedOwner = ownerId?.trim();
    if (normalizedOwner) {
      const scoped = bucket.get(normalizedOwner);
      if (scoped) {
        return scoped;
      }
    }

    return bucket.get(PUBLIC_SCOPE);
  }

  async hotLoad(platform: string, filePath: string): Promise<void> {
    await this.hotLoadPublic(platform, filePath);
  }

  async hotLoadPublic(platform: string, filePath: string): Promise<void> {
    const normalizedPlatform = normalizePlatform(platform);
    const absolutePath = path.resolve(filePath);
    const loaded = await this.loadFactoryFromFile(normalizedPlatform, absolutePath, true);
    this.registerPublic(normalizedPlatform, loaded.factory, absolutePath, loaded.meta, loaded.manifest);
    logger.info("adapter_hot_loaded_public", {
      platform: normalizedPlatform,
      filePath: absolutePath,
    });
  }

  async hotLoadScoped(platform: string, ownerId: string, filePath: string): Promise<void> {
    const normalizedPlatform = normalizePlatform(platform);
    const normalizedOwner = ownerId.trim();
    if (!normalizedOwner) {
      throw new Error("Cannot hot-load scoped adapter without an owner id.");
    }

    const absolutePath = path.resolve(filePath);
    const loaded = await this.loadFactoryFromFile(normalizedPlatform, absolutePath, true);
    this.registerScoped(
      normalizedPlatform,
      normalizedOwner,
      loaded.factory,
      absolutePath,
      loaded.meta,
      loaded.manifest,
    );
    logger.info("adapter_hot_loaded_sandbox", {
      platform: normalizedPlatform,
      ownerId: normalizedOwner,
      filePath: absolutePath,
    });
  }

  async hotLoadByPlatform(platform: string): Promise<void> {
    const normalizedPlatform = normalizePlatform(platform);
    if (!normalizedPlatform) {
      throw new Error("Cannot hot-load adapter with an empty platform name.");
    }

    const filePath = resolvePublicAdapterPath(normalizedPlatform);
    await this.hotLoadPublic(normalizedPlatform, filePath);
  }

  async seedBundledAdapters(): Promise<void> {
    const bundledDirectory = this.resolveBundledAdaptersDirectory();
    if (!fs.existsSync(bundledDirectory)) {
      logger.info("bundled_adapter_directory_missing", {
        bundledDirectory,
      });
      return;
    }

    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(bundledDirectory, { withFileTypes: true });
    } catch (error) {
      logger.warn("bundled_adapter_directory_read_failed", {
        bundledDirectory,
        error,
      });
      return;
    }

    const files = dirEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    for (const fileName of files) {
      const bundledFilePath = path.join(bundledDirectory, fileName);

      try {
        const sourceCode = fs.readFileSync(bundledFilePath, "utf8");
        const bundledManifest = extractBundledManifest(sourceCode);
        if (!bundledManifest) {
          logger.warn("bundled_adapter_manifest_parse_failed", {
            bundledFilePath,
          });
          continue;
        }

        const platform = normalizePlatform(bundledManifest.platform);
        const runtimeFilePath = resolvePublicAdapterPath(platform);

        const existing = await getBundledAdapterState(platform);
        if (!existing) {
          fs.mkdirSync(path.dirname(runtimeFilePath), { recursive: true });
          fs.writeFileSync(runtimeFilePath, sourceCode, { encoding: "utf8", mode: 0o600 });
          const seeded = await seedBundledAdapter({
            platform,
            filePath: runtimeFilePath,
            sourceCode,
          });
          await this.hotLoadPublic(platform, runtimeFilePath);
          logger.info("bundled_adapter_seeded", {
            platform,
            version: bundledManifest.version,
            adapterId: seeded.adapterId,
            bundledFilePath,
            runtimeFilePath,
          });
          continue;
        }

        if (existing.ownerId !== "system") {
          const db = (await import("../db/client.js")).getDb();
          await db.execute({
            sql: `UPDATE adapters SET owner_id = 'system', promoted_by = 'system' WHERE id = ?`,
            args: [existing.id],
          });
          logger.info("bundled_adapter_ownership_fixed", {
            platform,
            adapterId: existing.id,
            previousOwner: existing.ownerId,
          });
        }

        if (!existing.version) {
          logger.info("bundled_adapter_skipped", {
            platform,
            bundledVersion: bundledManifest.version,
            existingVersion: null,
            adapterId: existing.id,
            reason: "existing_version_unparseable",
            bundledFilePath,
            runtimeFilePath,
          });
          continue;
        }

        const versionComparison = compareSemverVersions(existing.version, bundledManifest.version);
        if (versionComparison >= 0) {
          logger.info("bundled_adapter_skipped", {
            platform,
            bundledVersion: bundledManifest.version,
            existingVersion: existing.version,
            adapterId: existing.id,
            reason: versionComparison === 0 ? "same_version" : "existing_is_newer",
            bundledFilePath,
            runtimeFilePath,
          });
          continue;
        }

        fs.mkdirSync(path.dirname(runtimeFilePath), { recursive: true });
        fs.writeFileSync(runtimeFilePath, sourceCode, { encoding: "utf8", mode: 0o600 });
        await updateBundledAdapter({
          adapterId: existing.id,
          filePath: runtimeFilePath,
          sourceCode,
        });
        await this.hotLoadPublic(platform, runtimeFilePath);
        logger.info("bundled_adapter_updated", {
          platform,
          bundledVersion: bundledManifest.version,
          existingVersion: existing.version,
          adapterId: existing.id,
          bundledFilePath,
          runtimeFilePath,
        });
      } catch (error) {
        logger.warn("bundled_adapter_seed_failed", {
          bundledFilePath,
          error,
        });
      }
    }
  }

  async restoreFromDatabase(): Promise<void> {
    let adapters: AdapterRecord[];
    try {
      adapters = await getAdaptersWithSource();
    } catch (error) {
      logger.warn("adapter_restore_from_db_failed", {
        error,
      });
      return;
    }

    for (const adapter of adapters) {
      if (!adapter.sourceCode) {
        continue;
      }

      try {
        this.restoreAdapterFile(adapter);
        this.knownAdapterFingerprints.set(adapter.id, this.fingerprintForAdapter(adapter));
        logger.info("adapter_restored_from_db", {
          platform: adapter.platform,
          status: adapter.status,
          adapterId: adapter.id,
        });
      } catch (error) {
        logger.warn("adapter_restore_single_failed", {
          platform: adapter.platform,
          status: adapter.status,
          adapterId: adapter.id,
          error,
        });
      }
    }
  }

  async syncFromDatabase(): Promise<void> {
    let adapters: AdapterRecord[];
    try {
      adapters = await getAdaptersWithSource();
    } catch (error) {
      logger.warn("adapter_sync_from_db_failed", {
        error,
      });
      return;
    }

    const seenAdapterIds = new Set<string>();

    for (const adapter of adapters) {
      seenAdapterIds.add(adapter.id);
      if (!adapter.sourceCode) {
        continue;
      }

      const fingerprint = this.fingerprintForAdapter(adapter);
      const knownFingerprint = this.knownAdapterFingerprints.get(adapter.id);
      if (knownFingerprint === fingerprint) {
        continue;
      }

      try {
        this.restoreAdapterFile(adapter);

        const previousStatus = this.statusFromFingerprint(knownFingerprint);
        if (previousStatus && previousStatus !== adapter.status) {
          if (previousStatus === "public") {
            this.unregisterPublic(adapter.platform);
          } else {
            this.unregisterScoped(adapter.platform, adapter.ownerId);
          }
        }

        if (adapter.status === "public") {
          await this.hotLoadPublic(adapter.platform, adapter.filePath);
        } else {
          await this.hotLoadScoped(adapter.platform, adapter.ownerId, adapter.filePath);
        }

        this.knownAdapterFingerprints.set(adapter.id, fingerprint);
        logger.info("adapter_synced_from_db", {
          platform: adapter.platform,
          status: adapter.status,
          adapterId: adapter.id,
        });
      } catch (error) {
        logger.warn("adapter_sync_single_failed", {
          platform: adapter.platform,
          status: adapter.status,
          adapterId: adapter.id,
          error,
        });
      }
    }

    for (const adapterId of Array.from(this.knownAdapterFingerprints.keys())) {
      if (!seenAdapterIds.has(adapterId)) {
        this.knownAdapterFingerprints.delete(adapterId);
      }
    }
  }

  async loadDynamicAdapters(): Promise<void> {
    const dynamicDirectory = resolveRuntimeAdaptersDirectory();
    const loadedFromDb = new Set<string>();
    let dbReady = false;

    try {
      const rows = await listActiveAdapters();
      dbReady = true;

      for (const row of rows) {
        try {
          if (row.status === "public") {
            await this.hotLoadPublic(row.platform, row.filePath);
          } else {
            await this.hotLoadScoped(row.platform, row.ownerId, row.filePath);
          }

          if (row.sourceCode) {
            this.knownAdapterFingerprints.set(row.id, this.fingerprintForAdapter(row));
          }

          loadedFromDb.add(row.platform);
        } catch (error) {
          logger.warn("adapter_load_active_record_failed", {
            platform: row.platform,
            status: row.status,
            filePath: row.filePath,
            error,
          });

          // Clean up orphaned DB records (file deleted but row remains)
          try {
            await deleteAdapterById(row.id);
            logger.info("adapter_orphaned_record_cleaned", {
              platform: row.platform,
              id: row.id,
              filePath: row.filePath,
            });
          } catch (cleanupError) {
            logger.warn("adapter_orphaned_record_cleanup_failed", {
              platform: row.platform,
              id: row.id,
              error: cleanupError,
            });
          }
        }
      }
    } catch (error) {
      logger.warn("adapter_load_active_records_failed", {
        error,
      });
    }

    if (!fs.existsSync(dynamicDirectory)) {
      return;
    }

    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(dynamicDirectory, { withFileTypes: true });
    } catch (error) {
      logger.warn("adapter_dynamic_directory_read_failed", {
        directory: dynamicDirectory,
        error,
      });
      return;
    }

    const files = dirEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    for (const fileName of files) {
      const platform = normalizePlatform(fileName.replace(/\.ts$/i, ""));
      if (!platform) {
        logger.warn("adapter_dynamic_file_skipped_empty_platform", {
          fileName,
        });
        continue;
      }

      if (loadedFromDb.has(platform)) {
        continue;
      }

      const absolutePath = path.join(dynamicDirectory, fileName);
      try {
        await this.hotLoadPublic(platform, absolutePath);
        loadedFromDb.add(platform);


      } catch (error) {
        logger.warn("adapter_dynamic_load_failed", {
          platform,
          filePath: absolutePath,
          error,
        });
      }
    }
  }

  private resolveRestorablePath(filePath: string): string {
    const adaptersBase = path.resolve(resolveRuntimeAdaptersDirectory());
    const targetPath = path.resolve(filePath);
    const relativePath = path.relative(adaptersBase, targetPath);
    const escapesBase =
      relativePath === "" ||
      relativePath === "." ||
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath);

    if (escapesBase) {
      throw new Error(
        `Refusing to restore adapter path '${targetPath}' outside adapters directory '${adaptersBase}'.`,
      );
    }

    return targetPath;
  }

  private resolveBundledAdaptersDirectory(): string {
    const configured = process.env.AGENR_BUNDLED_ADAPTERS_DIR?.trim();
    if (!configured) {
      return path.resolve(process.cwd(), "data", "adapters");
    }

    if (path.isAbsolute(configured)) {
      return configured;
    }

    return path.resolve(process.cwd(), configured);
  }

  private restoreAdapterFile(adapter: AdapterRecord): void {
    if (!adapter.sourceCode) {
      throw new Error(`Adapter '${adapter.platform}' has no stored source code.`);
    }

    const safeFilePath = this.resolveRestorablePath(adapter.filePath);
    fs.mkdirSync(path.dirname(safeFilePath), { recursive: true });
    fs.writeFileSync(safeFilePath, adapter.sourceCode, { encoding: "utf8", mode: 0o600 });
  }

  private computeEffectiveSourceHash(adapter: AdapterRecord): string {
    if (adapter.sourceHash && adapter.sourceHash.trim()) {
      return adapter.sourceHash;
    }

    if (!adapter.sourceCode) {
      return "missing-source";
    }

    return createHash("sha256").update(adapter.sourceCode).digest("hex");
  }

  private fingerprintForAdapter(adapter: AdapterRecord): string {
    const registryStatus = adapter.status === "public" ? "public" : "sandbox";
    return `${this.computeEffectiveSourceHash(adapter)}:${registryStatus}`;
  }

  private statusFromFingerprint(fingerprint: string | undefined): AdapterStatus | null {
    if (!fingerprint) {
      return null;
    }

    const separator = fingerprint.lastIndexOf(":");
    if (separator <= 0) {
      return null;
    }

    const status = fingerprint.slice(separator + 1);
    if (status === "public" || status === "sandbox") {
      return status;
    }

    return null;
  }

  private listEntriesByStatus(status: AdapterStatus): AdapterEntry[] {
    const entries: AdapterEntry[] = [];

    for (const bucket of this.adapters.values()) {
      for (const entry of bucket.values()) {
        if (entry.status === status) {
          entries.push(entry);
        }
      }
    }

    return entries.sort((a, b) => a.platform.localeCompare(b.platform));
  }

  private getBucket(platform: string): Map<string, AdapterEntry> | undefined {
    return this.adapters.get(normalizePlatform(platform));
  }

  private getOrCreateBucket(platform: string): Map<string, AdapterEntry> {
    const normalizedPlatform = normalizePlatform(platform);
    const existing = this.adapters.get(normalizedPlatform);
    if (existing) {
      return existing;
    }

    const bucket = new Map<string, AdapterEntry>();
    this.adapters.set(normalizedPlatform, bucket);
    return bucket;
  }

  private storeEntry(entry: {
    platform: string;
    ownerId: string | undefined;
    status: AdapterStatus;
    factory: AdapterFactory;
    source: string;
    meta?: AdapterMeta;
    manifest?: AdapterManifest;
  }): void {
    const normalizedPlatform = normalizePlatform(entry.platform);
    const normalizedOwner = entry.ownerId?.trim();
    const scopeKey = toScopeKey(normalizedOwner);
    const bucket = this.getOrCreateBucket(normalizedPlatform);

    bucket.set(scopeKey, {
      platform: normalizedPlatform,
      ownerId: normalizedOwner,
      status: entry.status,
      factory: entry.factory,
      source: entry.source,
      meta: entry.meta,
      manifest: entry.manifest,
    });
  }

  private deleteEntry(platform: string, ownerId: string | undefined): boolean {
    const normalizedPlatform = normalizePlatform(platform);
    const bucket = this.adapters.get(normalizedPlatform);
    if (!bucket) {
      return false;
    }

    const deleted = bucket.delete(toScopeKey(ownerId?.trim()));
    if (bucket.size === 0) {
      this.adapters.delete(normalizedPlatform);
    }

    return deleted;
  }

  private async loadFactoryFromFile(
    normalizedPlatform: string,
    absolutePath: string,
    bustCache: boolean,
  ): Promise<{ factory: AdapterFactory; meta?: AdapterMeta; manifest?: AdapterManifest }> {
    if (!normalizedPlatform) {
      throw new Error("Cannot hot-load adapter with an empty platform name.");
    }

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Dynamic adapter file does not exist: '${absolutePath}'.`);
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolutePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to stat dynamic adapter file '${absolutePath}': ${message}`);
    }

    if (!stat.isFile()) {
      throw new Error(`Dynamic adapter path is not a file: '${absolutePath}'.`);
    }

    let loaded: Record<string, unknown>;
    let importPath = absolutePath;
    let temporaryImportPath: string | null = null;
    const sourceCode = fs.readFileSync(absolutePath, "utf8");
    const rewrittenSourceCode = rewriteAdapterApiSpecifier(sourceCode);
    if (bustCache || rewrittenSourceCode !== sourceCode) {
      temporaryImportPath = `${absolutePath}.hot-${Date.now()}-${++this.moduleReloadNonce}.ts`;
      fs.writeFileSync(temporaryImportPath, rewrittenSourceCode, "utf8");
      importPath = temporaryImportPath;
    }

    try {
      const moduleUrl = pathToFileURL(importPath).href;
      loaded = (await import(moduleUrl)) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to hot-load dynamic adapter '${normalizedPlatform}' from '${absolutePath}': ${message}`,
      );
    } finally {
      if (temporaryImportPath && fs.existsSync(temporaryImportPath)) {
        try {
          fs.unlinkSync(temporaryImportPath);
        } catch (error) {
          logger.warn("adapter_temp_module_cleanup_failed", {
            path: temporaryImportPath,
            error,
          });
        }
      }
    }

    const DynamicAdapter = loaded.default;
    if (!isAdapterConstructor(DynamicAdapter)) {
      throw new Error(
        `Dynamic adapter '${normalizedPlatform}' skipped: default export is not a valid AgpAdapter class.`,
      );
    }

    return {
      factory: (business, ctx) => new DynamicAdapter(business, ctx),
      meta: readMeta(loaded.meta),
      manifest: readManifest(isRecord(loaded.manifest) ? { platform: normalizedPlatform, ...(loaded.manifest as Record<string, unknown>) } : loaded.manifest),
    };
  }
}
