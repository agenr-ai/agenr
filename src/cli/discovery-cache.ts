import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { resolveDiscoveryCachePath } from "./paths";

const DISCOVERY_CACHE_VERSION = 1;
const DEFAULT_MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

const discoveryFindingsSchema = z.record(z.string(), z.array(z.string()));

const discoveryCacheSchema = z.object({
  version: z.literal(DISCOVERY_CACHE_VERSION),
  platformName: z.string().min(1),
  platformSlug: z.string().min(1),
  generatedAt: z
    .string()
    .min(1)
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: "generatedAt must be a valid timestamp.",
    }),
  model: z.string().min(1),
  provider: z.string().min(1),
  durationMs: z.number().int().min(0),
  sourceUrls: z.array(z.string().min(1)),
  docsUrl: z.string().min(1).optional(),
  pagesVisited: z.number().int().min(0),
  toolCalls: z.number().int().min(0),
  findings: discoveryFindingsSchema,
});

type DiscoveryCacheEntry = z.infer<typeof discoveryCacheSchema>;

type DiscoveryCacheReadErrorCode = "missing" | "invalid";

export class DiscoveryCacheReadError extends Error {
  readonly code: DiscoveryCacheReadErrorCode;
  readonly cachePath: string;

  constructor(code: DiscoveryCacheReadErrorCode, cachePath: string, message: string) {
    super(message);
    this.name = "DiscoveryCacheReadError";
    this.code = code;
    this.cachePath = cachePath;
  }
}

interface DiscoveryCacheReadResult {
  cache: DiscoveryCacheEntry;
  ageMs: number;
  cachePath: string;
}

function formatReadErrorMessage(cachePath: string, reason: string): string {
  return `Discovery cache at '${cachePath}' is invalid: ${reason}`;
}

export function readDiscoveryCache(
  platformSlug: string,
  options: { required?: boolean } = {},
): DiscoveryCacheReadResult | null {
  const cachePath = resolveDiscoveryCachePath(platformSlug);
  const required = options.required === true;

  if (!fs.existsSync(cachePath)) {
    if (required) {
      throw new DiscoveryCacheReadError(
        "missing",
        cachePath,
        `No discovery cache found for '${platformSlug}' at '${cachePath}'. Run without --skip-discovery or pass --rediscover to create it.`,
      );
    }
    return null;
  }

  let parsed: unknown;
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    if (required) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new DiscoveryCacheReadError("invalid", cachePath, formatReadErrorMessage(cachePath, detail));
    }
    return null;
  }

  const validated = discoveryCacheSchema.safeParse(parsed);
  if (!validated.success) {
    if (required) {
      throw new DiscoveryCacheReadError(
        "invalid",
        cachePath,
        formatReadErrorMessage(cachePath, validated.error.issues.map((issue) => issue.message).join("; ")),
      );
    }
    return null;
  }

  const generatedAtMs = Date.parse(validated.data.generatedAt);
  if (Number.isNaN(generatedAtMs)) {
    if (required) {
      throw new DiscoveryCacheReadError(
        "invalid",
        cachePath,
        formatReadErrorMessage(cachePath, "generatedAt must be a valid timestamp."),
      );
    }
    return null;
  }

  return {
    cache: validated.data,
    ageMs: Math.max(0, Date.now() - generatedAtMs),
    cachePath,
  };
}

function ensureParentDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function writeDiscoveryCache(platformSlug: string, cache: DiscoveryCacheEntry): void {
  const cachePath = resolveDiscoveryCachePath(platformSlug);
  const normalized = discoveryCacheSchema.parse({
    ...cache,
    version: DISCOVERY_CACHE_VERSION,
    platformSlug,
  });

  ensureParentDirectory(cachePath);
  fs.writeFileSync(cachePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export function isFreshDiscoveryCache(ageMs: number, maxAgeMs = DEFAULT_MAX_CACHE_AGE_MS): boolean {
  return ageMs >= 0 && ageMs < maxAgeMs;
}

export function formatCacheAge(ageMs: number): string {
  if (ageMs < 60_000) return "just now";

  const totalMinutes = Math.floor(ageMs / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}
