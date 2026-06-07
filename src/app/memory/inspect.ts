import { createDatabase } from "../../adapters/db/client.js";
import { createMemoryRepository } from "../../adapters/db/memory-repository.js";
import type { DurableTrace } from "./ports.js";
import { readConfig, resolveDbPath } from "../../config.js";

/**
 * Selector accepted by the CLI trace runtime helper.
 */
export interface DurableTraceSelector {
  /** Trace one specific durable by canonical ID. */
  id?: string;
  /** Trace the most recent exact or substring subject match. */
  subject?: string;
  /** Trace the newest durable from any state. */
  last?: boolean;
}

/**
 * Loads one trace payload from the shared agenr database for CLI inspection.
 *
 * @param input - Selector plus optional config and db-path overrides.
 * @returns Trace payload for the selected durable.
 */
export async function loadDurableTraceRuntime(input: DurableTraceSelector & { dbPath?: string; env?: NodeJS.ProcessEnv }): Promise<DurableTrace> {
  const selector = normalizeTraceSelector(input);
  const configPathOverride = normalizeOptionalString(input.env?.AGENR_CONFIG_PATH);
  const config = readConfig({
    configPath: configPathOverride,
    dbPath: normalizeOptionalString(input.dbPath) ?? normalizeOptionalString(input.env?.AGENR_DB_PATH),
  });
  const dbPath = normalizeOptionalString(input.dbPath) ?? normalizeOptionalString(input.env?.AGENR_DB_PATH) ?? resolveDbPath(config);
  const database = await createDatabase(dbPath);
  const repository = createMemoryRepository(database);

  try {
    const durableId = await resolveTraceDurableId(repository, selector);
    const trace = await repository.getDurableTrace(durableId);
    if (!trace) {
      throw new Error(`No agenr durable found for id ${durableId}.`);
    }

    return trace;
  } finally {
    await database.close();
  }
}

/**
 * Resolves one validated selector into the corresponding trace durable ID.
 *
 * @param repository - Memory read model used for lookups.
 * @param selector - Validated selector payload.
 * @returns Canonical durable ID for the selected durable.
 */
async function resolveTraceDurableId(
  repository: ReturnType<typeof createMemoryRepository>,
  selector: Required<Pick<DurableTraceSelector, "last">> & Pick<DurableTraceSelector, "id" | "subject">,
): Promise<string> {
  if (selector.last) {
    const durable = await repository.findMostRecentDurable();
    if (!durable) {
      throw new Error("No agenr durables exist yet.");
    }

    return durable.id;
  }

  if (selector.id) {
    return selector.id;
  }

  const durable = await repository.findDurableBySubject(selector.subject ?? "");
  if (!durable) {
    throw new Error(`No agenr durable found for subject "${selector.subject}".`);
  }

  return durable.id;
}

/**
 * Validates that exactly one trace selector is present.
 *
 * @param selector - Raw selector payload.
 * @returns Normalized selector payload.
 */
function normalizeTraceSelector(selector: DurableTraceSelector): Required<Pick<DurableTraceSelector, "last">> & Pick<DurableTraceSelector, "id" | "subject"> {
  const id = normalizeOptionalString(selector.id);
  const subject = normalizeOptionalString(selector.subject);
  const last = selector.last === true;
  const count = (id ? 1 : 0) + (subject ? 1 : 0) + (last ? 1 : 0);
  if (count !== 1) {
    throw new Error("Provide exactly one trace selector: --id, --subject, or --last.");
  }

  return {
    ...(id ? { id } : {}),
    ...(subject ? { subject } : {}),
    last,
  };
}

/**
 * Normalizes optional strings by trimming empties to undefined.
 *
 * @param value - Candidate string field.
 * @returns Trimmed value, or undefined when absent.
 */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
