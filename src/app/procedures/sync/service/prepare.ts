import { computeProcedureRevisionHash, computeProcedureSourceHash } from "../../../../core/procedures/hashing.js";
import { parseAndNormalizeProcedureYaml } from "../../../../core/procedures/normalization.js";
import { composeProcedureRecallText } from "../../../../core/procedures/recall-text.js";
import type { Procedure } from "../../../../core/types.js";
import type { ProcedureSyncPorts } from "../ports.js";
import type {
  PreparedProcedureCandidate,
  ProcedureSyncCreateItem,
  ProcedureSyncInvalidItem,
  ProcedureSyncPlan,
  ProcedureSyncPlanItem,
  ProcedureSyncPlanTotals,
  ProcedureSyncSupersedeItem,
  ProcedureSyncUnchangedItem,
  ProcedureSyncUpdateSourceOnlyItem,
} from "../types.js";

/**
 * Builds a pure sync plan from repo-authored procedure files and current DB state.
 *
 * @param targetPath - File or directory path to inspect for procedure YAML files.
 * @param ports - Filesystem and database adapters used for planning.
 * @returns Discovery-order sync plan with explicit action buckets.
 */
export async function prepareProcedureSync(targetPath: string, ports: Pick<ProcedureSyncPorts, "files" | "db">): Promise<ProcedureSyncPlan> {
  const files = await ports.files.discoverFiles(targetPath);
  const discoveredItems = await Promise.all(files.map((filePath) => prepareCandidateForFile(filePath, ports)));
  const duplicateKeys = collectDuplicateProcedureKeys(discoveredItems);
  const planItems: ProcedureSyncPlanItem[] = [];

  for (const discoveredItem of discoveredItems) {
    if ("action" in discoveredItem) {
      planItems.push(discoveredItem);
      continue;
    }

    const duplicates = duplicateKeys.get(discoveredItem.procedure.procedure_key);
    if (duplicates && duplicates.length > 1) {
      planItems.push({
        action: "invalid",
        filePath: discoveredItem.filePath,
        error: formatDuplicateProcedureKeyError(discoveredItem.procedure.procedure_key, duplicates),
      });
      continue;
    }

    const existing = await ports.db.findActiveProcedureByKey(discoveredItem.procedure.procedure_key);
    planItems.push(classifyProcedureCandidate(discoveredItem, existing));
  }

  return {
    targetPath,
    files,
    items: planItems,
    totals: summarizePlan(planItems, files.length),
  };
}

/**
 * Reads, validates, and prepares one procedure candidate for planning.
 *
 * @param filePath - Absolute procedure file path.
 * @param ports - Filesystem adapter used to read the file.
 * @returns Prepared candidate or an invalid planning item.
 */
async function prepareCandidateForFile(
  filePath: string,
  ports: Pick<ProcedureSyncPorts, "files">,
): Promise<PreparedProcedureCandidate | ProcedureSyncInvalidItem> {
  try {
    const sourceText = await ports.files.readFile(filePath);
    const procedure = parseAndNormalizeProcedureYaml(sourceText, filePath);
    return {
      filePath,
      procedure,
      recallText: composeProcedureRecallText(procedure),
      revisionHash: computeProcedureRevisionHash(procedure),
      sourceHash: computeProcedureSourceHash(sourceText),
    };
  } catch (error) {
    return {
      action: "invalid",
      filePath,
      error: formatUnknownError(error),
    };
  }
}

/**
 * Collects procedure keys that appear more than once in the discovered corpus.
 *
 * @param items - Discovery-order prepared candidates and invalid items.
 * @returns Duplicate procedure-key map keyed by normalized procedure key.
 */
function collectDuplicateProcedureKeys(items: Array<PreparedProcedureCandidate | ProcedureSyncInvalidItem>): Map<string, string[]> {
  const filesByProcedureKey = new Map<string, string[]>();

  for (const item of items) {
    if ("action" in item) {
      continue;
    }

    const files = filesByProcedureKey.get(item.procedure.procedure_key) ?? [];
    files.push(item.filePath);
    filesByProcedureKey.set(item.procedure.procedure_key, files);
  }

  return new Map(Array.from(filesByProcedureKey.entries()).filter(([, files]) => files.length > 1));
}

/**
 * Classifies one prepared candidate against the current active stored revision.
 *
 * @param candidate - Prepared candidate derived from YAML.
 * @param existing - Active stored procedure revision, when one exists.
 * @returns One explicit planning item.
 */
function classifyProcedureCandidate(
  candidate: PreparedProcedureCandidate,
  existing: Procedure | null,
): ProcedureSyncCreateItem | ProcedureSyncUpdateSourceOnlyItem | ProcedureSyncSupersedeItem | ProcedureSyncUnchangedItem {
  if (!existing) {
    return {
      action: "create",
      candidate,
    };
  }

  if (existing.revision_hash !== candidate.revisionHash) {
    return {
      action: "supersede",
      candidate,
      existing,
    };
  }

  if (existing.source_hash !== candidate.sourceHash || existing.source_file !== candidate.filePath) {
    return {
      action: "update_source_only",
      candidate,
      existing,
    };
  }

  return {
    action: "unchanged",
    candidate,
    existing,
  };
}

/**
 * Summarizes planning counts for CLI display and tests.
 *
 * @param items - Discovery-order plan items.
 * @param discoveredCount - Total number of discovered files.
 * @returns Aggregate planning totals.
 */
function summarizePlan(items: ProcedureSyncPlanItem[], discoveredCount: number): ProcedureSyncPlanTotals {
  return items.reduce<ProcedureSyncPlanTotals>(
    (totals, item) => {
      switch (item.action) {
        case "create":
          totals.create += 1;
          break;
        case "update_source_only":
          totals.updateSourceOnly += 1;
          break;
        case "supersede":
          totals.supersede += 1;
          break;
        case "unchanged":
          totals.unchanged += 1;
          break;
        case "invalid":
          totals.invalid += 1;
          break;
      }

      return totals;
    },
    {
      discovered: discoveredCount,
      create: 0,
      updateSourceOnly: 0,
      supersede: 0,
      unchanged: 0,
      invalid: 0,
    },
  );
}

/**
 * Formats one duplicate-procedure-key planning error.
 *
 * @param procedureKey - Duplicate normalized procedure key.
 * @param filePaths - Files that define the same key.
 * @returns Human-readable planning error.
 */
function formatDuplicateProcedureKeyError(procedureKey: string, filePaths: string[]): string {
  return `Duplicate procedure_key "${procedureKey}" found in ${filePaths.join(", ")}.`;
}

/**
 * Converts unknown thrown values into readable error messages.
 *
 * @param error - Unknown thrown value.
 * @returns Human-readable message.
 */
function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
