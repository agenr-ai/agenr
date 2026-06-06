import type { RecallEvalSandboxRequest } from "./recall/contracts.js";

/** Dreaming eval scoreboard arms provisioned through eval sandboxes. */
export type AblationArm = "memory-off" | "store-only" | "dreaming-on";

const ABLATION_ARMS = new Set<AblationArm>(["memory-off", "store-only", "dreaming-on"]);

/** Optional profile snapshot fixture seeded for dreaming-on eval cases. */
export interface EvalProfileSnapshotFixture {
  /** Optional stable snapshot identifier. */
  id?: string;
  /** Ordered durable ids included in the active profile bundle. */
  durableIds: string[];
  /** Optional directive ids tracked alongside the profile bundle. */
  directiveIds?: string[];
  /** Optional as-of timestamp for the projected bundle. */
  asOf?: string;
  /** Optional dreaming run id that produced the snapshot. */
  runId?: string;
  /** Optional creation timestamp used for freshness guards. */
  createdAt?: string;
}

/** Resolved ablation controls extracted from one eval sandbox request. */
export interface ResolvedAblationConfig {
  /** Active ablation arm when the harness requested one. */
  arm?: AblationArm;
  /** Optional fixed wall-clock instant for temporal fixtures. */
  now?: string;
  /** Optional profile snapshot fixture for dreaming-on provisioning. */
  profileSnapshot?: EvalProfileSnapshotFixture;
}

/**
 * Parses and normalizes ablation controls from a recall/before-turn sandbox.
 */
export function resolveAblationConfig(sandbox: RecallEvalSandboxRequest | undefined): ResolvedAblationConfig {
  const arm = parseAblationArm(sandbox?.ablationArm);
  const now = sandbox?.now?.trim();
  const profileSnapshot = sandbox?.profileSnapshot;

  return {
    ...(arm ? { arm } : {}),
    ...(now ? { now } : {}),
    ...(profileSnapshot ? { profileSnapshot } : {}),
  };
}

/** Returns true when the harness requested the fully stubbed memory-off arm. */
export function isMemoryOffArm(config: ResolvedAblationConfig): boolean {
  return config.arm === "memory-off";
}

/** Returns true when profile snapshot provisioning should run for this case. */
export function shouldProvisionProfileSnapshot(config: ResolvedAblationConfig): boolean {
  return config.arm === "dreaming-on" && config.profileSnapshot !== undefined;
}

/** Parses one ablation-arm enum value. */
function parseAblationArm(value: unknown): AblationArm | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !ABLATION_ARMS.has(value as AblationArm)) {
    throw new Error(`sandbox.ablationArm must be one of: ${[...ABLATION_ARMS].join(", ")}.`);
  }

  return value as AblationArm;
}
