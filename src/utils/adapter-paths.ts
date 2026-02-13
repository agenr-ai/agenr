import path from "node:path";

function resolveProjectRoot(): string {
  return path.resolve(import.meta.dir, "../..");
}

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\.\.+/g, "_")
    .replace(/\s+/g, "-");
}

function assertNoTraversalTokens(value: string, label: string): void {
  if (value.includes("..") || /[\\/]/.test(value)) {
    throw new Error(`[path] ${label} contains path traversal tokens.`);
  }
}

function ensureNonEmptySegment(value: string, label: string): string {
  if (!value) {
    throw new Error(`[path] ${label} cannot resolve to an empty path segment.`);
  }

  return value;
}

function normalizePlatformSegment(platform: string): string {
  const trimmed = platform.trim().toLowerCase();
  assertNoTraversalTokens(trimmed, "Platform");
  const normalized = sanitizePathSegment(trimmed);
  return ensureNonEmptySegment(normalized, "Platform");
}

function ensurePathWithinBase(targetPath: string, baseDir: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedBase, resolvedTarget);
  const escapesBase =
    relative === "" || relative === "." || relative.startsWith("..") || path.isAbsolute(relative);

  if (escapesBase) {
    throw new Error(
      `[path] Resolved adapter path '${resolvedTarget}' escapes directory '${resolvedBase}'.`,
    );
  }

  return resolvedTarget;
}

/** Bundled (immutable) adapter source directory — never written to at runtime. */
export function resolveAdaptersBaseDirectory(): string {
  const configured = process.env.AGENR_ADAPTERS_DIR?.trim();
  if (!configured) {
    return path.resolve(resolveProjectRoot(), "data", "adapters");
  }

  if (path.isAbsolute(configured)) {
    return configured;
  }

  return path.resolve(resolveProjectRoot(), configured);
}

/** Runtime adapter directory — DB restores, seeder writes, and hot-loader reads from here. */
export function resolveRuntimeAdaptersDirectory(): string {
  const configured = process.env.AGENR_RUNTIME_ADAPTERS_DIR?.trim();
  if (!configured) {
    return path.resolve(resolveProjectRoot(), "data", "runtime-adapters");
  }

  if (path.isAbsolute(configured)) {
    return configured;
  }

  return path.resolve(resolveProjectRoot(), configured);
}

export function resolvePublicAdapterPath(platform: string): string {
  const runtimeBase = resolveRuntimeAdaptersDirectory();
  return ensurePathWithinBase(
    path.join(runtimeBase, `${normalizePlatformSegment(platform)}.ts`),
    runtimeBase,
  );
}

export function resolveSandboxAdapterPath(ownerId: string, platform: string): string {
  assertNoTraversalTokens(ownerId.trim(), "Owner id");
  const ownerSegment = ensureNonEmptySegment(sanitizePathSegment(ownerId), "Owner id");
  const normalizedPlatform = normalizePlatformSegment(platform);
  const runtimeBase = resolveRuntimeAdaptersDirectory();
  return ensurePathWithinBase(
    path.join(runtimeBase, ownerSegment, `${normalizedPlatform}.ts`),
    runtimeBase,
  );
}

export function resolveRejectedAdapterPath(platform: string, adapterId: string): string {
  const normalizedPlatform = normalizePlatformSegment(platform);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rejectedName = `${normalizedPlatform}-${sanitizePathSegment(adapterId)}-${timestamp}.ts`;
  const runtimeBase = resolveRuntimeAdaptersDirectory();
  return ensurePathWithinBase(path.join(runtimeBase, "_rejected", rejectedName), runtimeBase);
}

export function resolveRuntimeInteractionProfilePath(platform: string): string {
  return path.join(resolveProjectRoot(), "data", "interaction-profiles", `${platform.trim().toLowerCase()}.json`);
}
