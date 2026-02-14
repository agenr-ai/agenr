import { migrate } from "../db/migrate";
import { logAuditWithTimestamp } from "../vault/audit";
import type { AuditAction } from "../vault/audit-types";

const DEFAULT_USER_ID = "admin";
const DEFAULT_SERVICE = "square";
const DEFAULT_COUNT = 25;
const SEED_SPAN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTION_ROTATION: AuditAction[] = [
  "credential_retrieved",
  "credential_stored",
  "dek_generated",
  "dek_unwrapped",
];

interface SeedArgs {
  userId: string;
  service: string;
  count: number;
}

function usageMessage(): string {
  return [
    "Usage: pnpm run seed:activity -- [--user-id <id>] [--service <name>] [--count <n>]",
    "",
    "Defaults:",
    `  --user-id ${DEFAULT_USER_ID}`,
    `  --service ${DEFAULT_SERVICE}`,
    `  --count ${DEFAULT_COUNT}`,
  ].join("\n");
}

function parsePositiveInteger(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readRequiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function parseArgs(args: string[]): SeedArgs {
  const parsed: SeedArgs = {
    userId: DEFAULT_USER_ID,
    service: DEFAULT_SERVICE,
    count: DEFAULT_COUNT,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      throw new Error(usageMessage());
    }

    if (arg === "--user-id") {
      parsed.userId = readRequiredValue(args, index, arg).trim();
      index += 1;
      continue;
    }

    if (arg === "--service") {
      parsed.service = readRequiredValue(args, index, arg).trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg === "--count") {
      parsed.count = parsePositiveInteger(readRequiredValue(args, index, arg), "count");
      index += 1;
      continue;
    }

    throw new Error(`Unexpected argument '${arg}'`);
  }

  if (!parsed.userId) {
    throw new Error("user-id cannot be empty");
  }

  if (!parsed.service) {
    throw new Error("service cannot be empty");
  }

  return parsed;
}

function activityTimestamp(index: number, count: number, nowMs: number): string {
  if (count <= 1) {
    return new Date(nowMs).toISOString();
  }

  const spanMs = SEED_SPAN_DAYS * DAY_MS;
  const startMs = nowMs - spanMs;
  const progress = index / (count - 1);
  return new Date(startMs + Math.floor(progress * spanMs)).toISOString();
}

function metadataForAction(action: AuditAction, service: string, index: number): Record<string, unknown> {
  if (action === "credential_retrieved") {
    return {
      domain: `api.${service}.com`,
      adapter: service,
      method: "read",
    };
  }

  if (action === "credential_stored") {
    return {
      domain: `auth.${service}.com`,
      adapter: service,
      method: "upsert",
    };
  }

  if (action === "dek_generated") {
    return {
      adapter: service,
      operation: "vault_keygen",
      batch: Math.floor(index / ACTION_ROTATION.length) + 1,
    };
  }

  return {
    adapter: service,
    operation: "vault_unwrap",
    execution: `seed-exec-${index + 1}`,
  };
}

function executionIdForAction(action: AuditAction, index: number): string | undefined {
  if (action === "credential_retrieved" || action === "dek_unwrapped") {
    return `seed-exec-${index + 1}`;
  }

  return undefined;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await migrate();

  const nowMs = Date.now();
  const actionCounts = new Map<AuditAction, number>();

  for (let index = 0; index < args.count; index += 1) {
    const action = ACTION_ROTATION[index % ACTION_ROTATION.length] as AuditAction;
    const timestamp = activityTimestamp(index, args.count, nowMs);

    await logAuditWithTimestamp(
      {
        userId: args.userId,
        serviceId: args.service,
        action,
        executionId: executionIdForAction(action, index),
        metadata: metadataForAction(action, args.service, index),
      },
      timestamp,
    );

    actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
  }

  const summary = ACTION_ROTATION.map((action) => `${action}: ${actionCounts.get(action) ?? 0}`).join(", ");
  console.log(
    `Seeded ${args.count} audit entries for user='${args.userId}' service='${args.service}' across last ${SEED_SPAN_DAYS} days (${summary}).`,
  );
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (message !== usageMessage()) {
    console.error("\n" + usageMessage());
  }
  process.exitCode = 1;
});
