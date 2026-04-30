import { createDatabase } from "../../adapters/db/client.js";
import { createMemoryRepository } from "../../adapters/db/memory-repository.js";
import type { EntryTrace } from "./ports.js";
import { readConfig, resolveDbPath } from "../../config.js";

/**
 * Selector accepted by the CLI trace runtime helper.
 */
export interface EntryTraceSelector {
  /** Trace one specific entry by canonical ID. */
  id?: string;
  /** Trace the most recent exact or substring subject match. */
  subject?: string;
  /** Trace the newest entry from any state. */
  last?: boolean;
}

/**
 * Loads one trace payload from the shared agenr database for CLI inspection.
 *
 * @param input - Selector plus optional config and db-path overrides.
 * @returns Trace payload for the selected entry.
 */
export async function loadEntryTraceRuntime(input: EntryTraceSelector & { dbPath?: string; env?: NodeJS.ProcessEnv }): Promise<EntryTrace> {
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
    const entryId = await resolveTraceEntryId(repository, selector);
    const trace = await repository.getEntryTrace(entryId);
    if (!trace) {
      throw new Error(`No agenr entry found for id ${entryId}.`);
    }

    return trace;
  } finally {
    await database.close();
  }
}

/**
 * Resolves one validated selector into the corresponding trace entry ID.
 *
 * @param repository - Memory read model used for lookups.
 * @param selector - Validated selector payload.
 * @returns Canonical entry ID for the selected entry.
 */
async function resolveTraceEntryId(
  repository: ReturnType<typeof createMemoryRepository>,
  selector: Required<Pick<EntryTraceSelector, "last">> & Pick<EntryTraceSelector, "id" | "subject">,
): Promise<string> {
  if (selector.last) {
    const entry = await repository.findMostRecentEntry();
    if (!entry) {
      throw new Error("No agenr entries exist yet.");
    }

    return entry.id;
  }

  if (selector.id) {
    return selector.id;
  }

  const entry = await repository.findEntryBySubject(selector.subject ?? "");
  if (!entry) {
    throw new Error(`No agenr entry found for subject "${selector.subject}".`);
  }

  return entry.id;
}

/**
 * Validates that exactly one trace selector is present.
 *
 * @param selector - Raw selector payload.
 * @returns Normalized selector payload.
 */
function normalizeTraceSelector(selector: EntryTraceSelector): Required<Pick<EntryTraceSelector, "last">> & Pick<EntryTraceSelector, "id" | "subject"> {
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
