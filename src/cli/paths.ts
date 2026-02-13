import fs from "node:fs";
import path from "node:path";

let cachedRoot: string | null = null;

function isAgenrRoot(dir: string): boolean {
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) return false;

  try {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    return parsed.name === "agenr";
  } catch {
    return false;
  }
}

export function resolveProjectRoot(cwd = process.cwd()): string {
  if (cachedRoot) return cachedRoot;

  let current = path.resolve(cwd);
  while (true) {
    if (isAgenrRoot(current)) {
      cachedRoot = current;
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(
    `Could not resolve Agenr project root from '${path.resolve(
      cwd,
    )}'. Expected a parent directory with package.json name 'agenr'.`,
  );
}

export function resolveConfigPath(): string {
  return path.join(resolveProjectRoot(), "data", "agenr-config.json");
}

export function resolveAdapterPath(slug: string): string {
  return path.join(resolveProjectRoot(), "data", "adapters", `${slug}.ts`);
}

export function resolveInteractionProfilePath(slug: string): string {
  return path.join(resolveProjectRoot(), "data", "interaction-profiles", `${slug}.json`);
}

export function resolveDiscoveryCachePath(slug: string): string {
  return path.join(resolveProjectRoot(), "data", "discovery-cache", `${slug}.json`);
}

export function resolveRelativeToRoot(...segments: string[]): string {
  return path.join(resolveProjectRoot(), ...segments);
}
