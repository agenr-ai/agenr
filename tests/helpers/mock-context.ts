import { AdapterContext, type AuthCredential } from "../../src/adapters/context";
import type { AdapterManifest } from "../../src/adapters/manifest";

interface MockContextOptions {
  platform?: string;
  userId?: string;
  executionId?: string;
  manifest?: AdapterManifest;
  authenticatedDomains?: string[];
  allowedDomains?: string[];
  credential?: AuthCredential | null;
  resolveCredential?: (options?: { force?: boolean }) => Promise<AuthCredential | null>;
}

export function createMockContext(options: MockContextOptions = {}): AdapterContext {
  const platform = options.platform ?? "test-platform";
  const manifest: AdapterManifest =
    options.manifest ?? {
      platform,
      auth: {
        type: "none",
        strategy: "none",
      },
      authenticatedDomains: options.authenticatedDomains ?? [],
      allowedDomains: options.allowedDomains ?? ["localhost", "127.0.0.1"],
    };

  return new AdapterContext({
    platform,
    userId: options.userId ?? "test-user",
    executionId: options.executionId ?? "test-execution",
    manifest,
    resolveCredential: options.resolveCredential ?? (async () => options.credential ?? null),
  });
}
