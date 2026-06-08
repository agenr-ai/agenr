import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isRecord } from "../../adapters/shared/validation.js";
import { readConfig, resolveConfigDir, resolveDbPath } from "../../config.js";
import { resolveLocalFilesystemPath } from "../../filesystem-path.js";

/** Schema version stamped on the persisted registry file. */
const REGISTRY_VERSION = 1;

/** Default registry file name stored under the agenr config directory. */
const REGISTRY_FILE_NAME = "web-instances.json";

/** Locked-down permissions for the registry directory and file. */
const REGISTRY_DIR_MODE = 0o700;
const REGISTRY_FILE_MODE = 0o600;

/**
 * One configured Agenr instance the operator console can target.
 *
 * The registry stores only references (paths), never database contents. The
 * resolved config and database path are validated lazily when an instance is
 * selected so a stale entry never blocks loading the registry itself.
 */
export interface WebInstanceRecord {
  /** Stable slug identifier derived from the name on creation. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Optional explicit config file path. Falls back to the default config. */
  configPath?: string;
  /** Optional explicit database path override. */
  dbPath?: string;
  /** Optional repo procedures directory used by the procedure editor. */
  proceduresDir?: string;
  /** ISO creation timestamp. */
  createdAt: string;
}

/**
 * Persisted registry document shape.
 */
export interface WebInstanceRegistry {
  /** Schema version for forward-compatible migrations. */
  version: number;
  /** Registered instances in insertion order. */
  instances: WebInstanceRecord[];
  /** Currently selected instance id, when one is selected. */
  selectedId?: string;
}

/**
 * Validated, fully resolved view of one instance ready for use by services.
 */
export interface ResolvedWebInstance {
  /** Backing registry record. */
  record: WebInstanceRecord;
  /** Resolved absolute (or `:memory:`) database path. */
  dbPath: string;
  /** Resolved config file path that was loaded. */
  configPath: string;
  /** True when the resolved database file exists on disk. */
  dbExists: boolean;
  /** Resolved procedures directory, when one is configured. */
  proceduresDir?: string;
}

/**
 * Input accepted when registering a new instance.
 */
export interface RegisterInstanceInput {
  /** Display name; also seeds the generated id slug. */
  name: string;
  /** Optional explicit config path. */
  configPath?: string;
  /** Optional explicit database path. */
  dbPath?: string;
  /** Optional repo procedures directory. */
  proceduresDir?: string;
}

/**
 * Options controlling where the registry is read from and written to.
 */
export interface InstanceRegistryOptions {
  /** Explicit registry file path override. */
  registryPath?: string;
  /** Environment map used to resolve the default registry directory. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the registry file path from explicit overrides or the config dir.
 *
 * @param options - Optional registry path and environment overrides.
 * @returns Absolute path to the registry JSON file.
 */
export function resolveRegistryPath(options: InstanceRegistryOptions = {}): string {
  const explicit = options.registryPath?.trim();
  if (explicit && explicit.length > 0) {
    return explicit;
  }

  return path.join(resolveConfigDir(options.env ?? process.env), REGISTRY_FILE_NAME);
}

/**
 * Converts a free-form display name into a stable slug id.
 *
 * @param name - Raw display name.
 * @returns Lowercased, hyphen-delimited slug, or `instance` when empty.
 */
export function slugifyInstanceName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug.length > 0 ? slug : "instance";
}

/**
 * Ensures a slug is unique against a set of existing ids by appending a suffix.
 *
 * @param base - Candidate slug.
 * @param existing - Set of ids already in use.
 * @returns Unique slug not present in `existing`.
 */
export function ensureUniqueInstanceId(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) {
    return base;
  }

  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

/**
 * Normalizes an optional path-like string into a trimmed value or undefined.
 *
 * @param value - Raw path input.
 * @returns Trimmed non-empty path, or undefined.
 */
export function normalizeOptionalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length === 0) {
    return undefined;
  }

  if (trimmed === ":memory:") {
    return trimmed;
  }

  return path.resolve(trimmed);
}

/**
 * Validates and normalizes a raw parsed registry document.
 *
 * Unknown or malformed entries are dropped rather than throwing so a single
 * corrupt row never bricks the console. The returned document is always a
 * well-formed {@link WebInstanceRegistry}.
 *
 * @param value - Raw parsed JSON value.
 * @returns Normalized registry document.
 */
export function normalizeRegistryDocument(value: unknown): WebInstanceRegistry {
  if (!isRecord(value) || !Array.isArray(value.instances)) {
    return { version: REGISTRY_VERSION, instances: [] };
  }

  const seen = new Set<string>();
  const instances: WebInstanceRecord[] = [];
  for (const entry of value.instances) {
    const record = normalizeRecord(entry, seen);
    if (record) {
      seen.add(record.id);
      instances.push(record);
    }
  }

  const selectedId = typeof value.selectedId === "string" && seen.has(value.selectedId) ? value.selectedId : undefined;

  return {
    version: REGISTRY_VERSION,
    instances,
    ...(selectedId ? { selectedId } : {}),
  };
}

/**
 * Reads the persisted registry, returning an empty document when none exists.
 *
 * @param options - Optional registry path and environment overrides.
 * @returns Normalized registry document.
 */
export async function readInstanceRegistry(options: InstanceRegistryOptions = {}): Promise<WebInstanceRegistry> {
  const registryPath = resolveRegistryPath(options);
  if (!existsSync(registryPath)) {
    return { version: REGISTRY_VERSION, instances: [] };
  }

  let parsed: unknown;
  try {
    const raw = await readFile(registryPath, "utf-8");
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid web instance registry at ${registryPath}: ${message}`, { cause: error });
  }

  return normalizeRegistryDocument(parsed);
}

/**
 * Registers a new instance after validating its resolved config and database.
 *
 * @param input - New instance definition.
 * @param options - Optional registry path and environment overrides.
 * @returns Updated registry document with the new record selected.
 * @throws Error When the name is empty or the resolved config fails to load.
 */
export async function registerInstance(input: RegisterInstanceInput, options: InstanceRegistryOptions = {}): Promise<WebInstanceRegistry> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new Error("Instance name must not be empty.");
  }

  const registry = await readInstanceRegistry(options);
  const existingIds = new Set(registry.instances.map((instance) => instance.id));
  const id = ensureUniqueInstanceId(slugifyInstanceName(name), existingIds);

  const configPath = normalizeOptionalPath(input.configPath);
  const dbPath = normalizeOptionalPath(input.dbPath);
  const proceduresDir = normalizeOptionalPath(input.proceduresDir);

  const record: WebInstanceRecord = {
    id,
    name,
    createdAt: new Date().toISOString(),
    ...(configPath ? { configPath } : {}),
    ...(dbPath ? { dbPath } : {}),
    ...(proceduresDir ? { proceduresDir } : {}),
  };

  // Validate the record resolves before persisting so we fail fast on bad paths.
  resolveInstanceRecord(record, options.env);

  const next: WebInstanceRegistry = {
    version: REGISTRY_VERSION,
    instances: [...registry.instances, record],
    selectedId: id,
  };
  await writeInstanceRegistry(next, options);
  return next;
}

/**
 * Removes an instance from the registry.
 *
 * @param id - Instance id to remove.
 * @param options - Optional registry path and environment overrides.
 * @returns Updated registry document.
 */
export async function removeInstance(id: string, options: InstanceRegistryOptions = {}): Promise<WebInstanceRegistry> {
  const registry = await readInstanceRegistry(options);
  const instances = registry.instances.filter((instance) => instance.id !== id);
  const selectedId = registry.selectedId === id ? instances[0]?.id : registry.selectedId;

  const next: WebInstanceRegistry = {
    version: REGISTRY_VERSION,
    instances,
    ...(selectedId ? { selectedId } : {}),
  };
  await writeInstanceRegistry(next, options);
  return next;
}

/**
 * Selects an instance after validating it resolves cleanly.
 *
 * @param id - Instance id to select.
 * @param options - Optional registry path and environment overrides.
 * @returns The resolved, validated instance.
 * @throws Error When the id is unknown or the instance fails to resolve.
 */
export async function selectInstance(id: string, options: InstanceRegistryOptions = {}): Promise<ResolvedWebInstance> {
  const registry = await readInstanceRegistry(options);
  const record = registry.instances.find((instance) => instance.id === id);
  if (!record) {
    throw new Error(`Unknown instance id: ${id}.`);
  }

  const resolved = resolveInstanceRecord(record, options.env);

  await writeInstanceRegistry({ ...registry, selectedId: id }, options);
  return resolved;
}

/**
 * Resolves the currently selected instance, or the first registered instance.
 *
 * @param options - Optional registry path and environment overrides.
 * @returns Resolved selected instance, or null when none are registered.
 */
export async function resolveSelectedInstance(options: InstanceRegistryOptions = {}): Promise<ResolvedWebInstance | null> {
  const registry = await readInstanceRegistry(options);
  const record = registry.instances.find((instance) => instance.id === registry.selectedId) ?? registry.instances[0];
  if (!record) {
    return null;
  }

  return resolveInstanceRecord(record, options.env);
}

/**
 * Resolves and validates one registry record into a usable instance.
 *
 * @param record - Registry record to resolve.
 * @param env - Environment map used during config and path resolution.
 * @returns Resolved instance with config path, database path, and existence.
 * @throws Error When the referenced config file cannot be loaded.
 */
export function resolveInstanceRecord(record: WebInstanceRecord, env: NodeJS.ProcessEnv = process.env): ResolvedWebInstance {
  const configOptions = {
    env,
    ...(record.configPath ? { configPath: record.configPath } : {}),
    ...(record.dbPath ? { dbPath: record.dbPath } : {}),
  };

  let config: ReturnType<typeof readConfig>;
  try {
    config = readConfig(configOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Instance "${record.name}" has an invalid config: ${message}`, { cause: error });
  }

  const dbPath = record.dbPath ?? resolveDbPath(config, env);
  const localDbPath = dbPath === ":memory:" ? null : resolveLocalFilesystemPath(dbPath);
  const dbExists = localDbPath !== null ? existsSync(localDbPath) : true;

  return {
    record,
    dbPath,
    configPath: record.configPath ?? "(default)",
    dbExists,
    ...(record.proceduresDir ? { proceduresDir: record.proceduresDir } : {}),
  };
}

/** Persists a registry document with locked-down permissions. */
async function writeInstanceRegistry(registry: WebInstanceRegistry, options: InstanceRegistryOptions): Promise<void> {
  const registryPath = resolveRegistryPath(options);
  await mkdir(path.dirname(registryPath), { recursive: true, mode: REGISTRY_DIR_MODE });
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf-8", mode: REGISTRY_FILE_MODE });
}

/** Normalizes one raw registry entry, dropping malformed rows. */
function normalizeRecord(value: unknown, seen: ReadonlySet<string>): WebInstanceRecord | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    return null;
  }

  const id = value.id.trim();
  const name = value.name.trim();
  if (id.length === 0 || name.length === 0 || seen.has(id)) {
    return null;
  }

  return {
    id,
    name,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    ...(typeof value.configPath === "string" && value.configPath.trim().length > 0 ? { configPath: value.configPath.trim() } : {}),
    ...(typeof value.dbPath === "string" && value.dbPath.trim().length > 0 ? { dbPath: value.dbPath.trim() } : {}),
    ...(typeof value.proceduresDir === "string" && value.proceduresDir.trim().length > 0 ? { proceduresDir: value.proceduresDir.trim() } : {}),
  };
}

