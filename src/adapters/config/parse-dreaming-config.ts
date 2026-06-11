import { parseOptionalBoolean, parseOptionalIntegerInRange, pushIssue, pushUnexpectedFields, isRecord, type ValidationIssue } from "../shared/validation.js";
import { parseModelConfig, hasModelConfig } from "./parse-model-config.js";
import {
  DEFAULT_DREAMING_DAILY_COST_CAP,
  DEFAULT_DREAMING_DEEP_INTERVAL_HOURS,
  DEFAULT_DREAMING_EXTRACT_MAX_SESSIONS,
  DEFAULT_DREAMING_LIGHT_MAX_SESSIONS,
  DEFAULT_DREAMING_IMPORTANCE_THRESHOLD,
  DEFAULT_DREAMING_MAX_PROFILE_DURABLES,
  DEFAULT_DREAMING_MIN_INTERVAL_MINUTES,
  DEFAULT_DREAMING_PRUNE_PROTECT_MIN_IMPORTANCE,
  DEFAULT_DREAMING_PRUNE_PROTECT_RECALLED_DAYS,
  DEFAULT_DREAMING_WORKING_SET_RETENTION_DAYS,
  type DreamingConfig,
  type ResolvedDreamingConfig,
  type ResolvedDreamingPruneConfig,
  type ResolvedDreamingReapConfig,
} from "./types.js";

/**
 * Parses the nested dreaming block.
 *
 * @param value - Raw nested value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Canonical persisted values plus the resolved runtime block.
 */
export function parseDreamingConfig(value: unknown, path: string, issues: ValidationIssue[]): { input?: DreamingConfig; resolved: ResolvedDreamingConfig } {
  const defaults = createDefaultDreamingConfig();
  if (value === undefined) {
    return { resolved: defaults };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: defaults };
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["model", "dailyCostCap", "tiers", "stages", "triggers"]), path, issues);

  const model = parseModelConfig(value.model, `${path}.model`, issues);
  const dailyCostCap = parseOptionalNonNegativeNumber(value.dailyCostCap, `${path}.dailyCostCap`, issues);
  const tiers = parseDreamingTiersConfig(value.tiers, `${path}.tiers`, issues);
  const stages = parseDreamingStagesConfig(value.stages, `${path}.stages`, issues);
  const triggers = parseDreamingTriggersConfig(value.triggers, `${path}.triggers`, issues);

  if (issues.length > startIndex) {
    return { resolved: defaults };
  }

  const input: DreamingConfig = {
    ...(model ? { model } : {}),
    ...(dailyCostCap !== undefined ? { dailyCostCap } : {}),
    ...(tiers.input ? { tiers: tiers.input } : {}),
    ...(stages.input ? { stages: stages.input } : {}),
    ...(triggers.input ? { triggers: triggers.input } : {}),
  };

  return {
    ...(hasDreamingInput(input) ? { input } : {}),
    resolved: {
      ...(model ? { model } : {}),
      dailyCostCap: dailyCostCap ?? defaults.dailyCostCap,
      tiers: tiers.resolved,
      stages: stages.resolved,
      triggers: triggers.resolved,
    },
  };
}

/** Parses the nested dreaming tier enablement block. */
function parseDreamingTiersConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: NonNullable<DreamingConfig["tiers"]>; resolved: ResolvedDreamingConfig["tiers"] } {
  const defaults = createDefaultDreamingConfig().tiers;
  if (value === undefined) {
    return { resolved: defaults };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: defaults };
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["light", "standard", "deep"]), path, issues);
  const light = parseDreamingTierEnabledConfig(value.light, `${path}.light`, issues);
  const standard = parseDreamingTierEnabledConfig(value.standard, `${path}.standard`, issues);
  const deep = parseDreamingDeepTierConfig(value.deep, `${path}.deep`, issues);

  if (issues.length > startIndex) {
    return { resolved: defaults };
  }

  const input: NonNullable<DreamingConfig["tiers"]> = {
    ...(light.input ? { light: light.input } : {}),
    ...(standard.input ? { standard: standard.input } : {}),
    ...(deep.input ? { deep: deep.input } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: {
      light: { enabled: light.resolved.enabled ?? defaults.light.enabled },
      standard: { enabled: standard.resolved.enabled ?? defaults.standard.enabled },
      deep: {
        enabled: deep.resolved.enabled ?? defaults.deep.enabled,
        intervalHours: deep.resolved.intervalHours ?? defaults.deep.intervalHours,
      },
    },
  };
}

/** Parses enablement for one dreaming tier. */
function parseDreamingTierEnabledConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: { enabled?: boolean }; resolved: { enabled?: boolean } } {
  if (value === undefined) {
    return { resolved: {} };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: {} };
  }

  pushUnexpectedFields(value, new Set(["enabled"]), path, issues);
  const enabled = parseOptionalBoolean(value.enabled, `${path}.enabled`, issues);
  const input = enabled !== undefined ? { enabled } : {};
  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: input,
  };
}

/** Parses the deep dreaming tier settings. */
function parseDreamingDeepTierConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: NonNullable<NonNullable<DreamingConfig["tiers"]>["deep"]>; resolved: Partial<ResolvedDreamingConfig["tiers"]["deep"]> } {
  if (value === undefined) {
    return { resolved: {} };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: {} };
  }

  pushUnexpectedFields(value, new Set(["enabled", "intervalHours"]), path, issues);
  const enabled = parseOptionalBoolean(value.enabled, `${path}.enabled`, issues);
  const intervalHours = parseOptionalIntegerInRange(value.intervalHours, `${path}.intervalHours`, issues, { min: 1 });
  const input: NonNullable<NonNullable<DreamingConfig["tiers"]>["deep"]> = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(intervalHours !== undefined ? { intervalHours } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: input,
  };
}

/** Parses the nested dreaming stage configuration block. */
function parseDreamingStagesConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: NonNullable<DreamingConfig["stages"]>; resolved: ResolvedDreamingConfig["stages"] } {
  const defaults = createDefaultDreamingConfig().stages;
  if (value === undefined) {
    return { resolved: defaults };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: defaults };
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["extract", "project", "prune", "reap"]), path, issues);
  const extract = parseDreamingExtractConfig(value.extract, `${path}.extract`, issues);
  const project = parseDreamingProjectConfig(value.project, `${path}.project`, issues);
  const prune = parseDreamingPruneConfig(value.prune, `${path}.prune`, issues);
  const reap = parseDreamingReapConfig(value.reap, `${path}.reap`, issues);

  if (issues.length > startIndex) {
    return { resolved: defaults };
  }

  const input: NonNullable<DreamingConfig["stages"]> = {
    ...(extract.input ? { extract: extract.input } : {}),
    ...(project.input ? { project: project.input } : {}),
    ...(prune.input ? { prune: prune.input } : {}),
    ...(reap.input ? { reap: reap.input } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: {
      extract: extract.resolved,
      project: project.resolved,
      prune: prune.resolved,
      reap: reap.resolved,
    },
  };
}

/** Parses the dreaming extract stage settings. */
function parseDreamingExtractConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: NonNullable<NonNullable<DreamingConfig["stages"]>["extract"]>; resolved: ResolvedDreamingConfig["stages"]["extract"] } {
  const defaults = createDefaultDreamingConfig().stages.extract;
  if (value === undefined) {
    return { resolved: defaults };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: defaults };
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["maxSessionsPerRun", "lightMaxSessionsPerRun", "contextLookup"]), path, issues);
  const maxSessionsPerRun = parseOptionalIntegerInRange(value.maxSessionsPerRun, `${path}.maxSessionsPerRun`, issues, { min: 1 });
  const lightMaxSessionsPerRun = parseOptionalIntegerInRange(value.lightMaxSessionsPerRun, `${path}.lightMaxSessionsPerRun`, issues, { min: 1 });
  const contextLookup = parseDreamingContextLookupConfig(value.contextLookup, `${path}.contextLookup`, issues);

  if (issues.length > startIndex) {
    return { resolved: defaults };
  }

  const input: NonNullable<NonNullable<DreamingConfig["stages"]>["extract"]> = {
    ...(maxSessionsPerRun !== undefined ? { maxSessionsPerRun } : {}),
    ...(lightMaxSessionsPerRun !== undefined ? { lightMaxSessionsPerRun } : {}),
    ...(contextLookup.input ? { contextLookup: contextLookup.input } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: {
      maxSessionsPerRun: maxSessionsPerRun ?? defaults.maxSessionsPerRun,
      lightMaxSessionsPerRun: lightMaxSessionsPerRun ?? defaults.lightMaxSessionsPerRun,
      contextLookup: contextLookup.resolved,
    },
  };
}

/** Parses context-lookup settings for dreaming extraction. */
function parseDreamingContextLookupConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): {
  input?: NonNullable<NonNullable<NonNullable<DreamingConfig["stages"]>["extract"]>["contextLookup"]>;
  resolved: ResolvedDreamingConfig["stages"]["extract"]["contextLookup"];
} {
  const defaults = createDefaultDreamingConfig().stages.extract.contextLookup;
  if (value === undefined) {
    return { resolved: defaults };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: defaults };
  }

  pushUnexpectedFields(value, new Set(["enabled"]), path, issues);
  const enabled = parseOptionalBoolean(value.enabled, `${path}.enabled`, issues);
  const input: NonNullable<NonNullable<NonNullable<DreamingConfig["stages"]>["extract"]>["contextLookup"]> = {
    ...(enabled !== undefined ? { enabled } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: {
      enabled: enabled ?? defaults.enabled,
    },
  };
}

/** Parses dreaming profile projection settings. */
function parseDreamingProjectConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: NonNullable<NonNullable<DreamingConfig["stages"]>["project"]>; resolved: ResolvedDreamingConfig["stages"]["project"] } {
  const defaults = createDefaultDreamingConfig().stages.project;
  if (value === undefined) {
    return { resolved: defaults };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: defaults };
  }

  pushUnexpectedFields(value, new Set(["maxProfileDurables"]), path, issues);
  const maxProfileDurables = parseOptionalIntegerInRange(value.maxProfileDurables, `${path}.maxProfileDurables`, issues, { min: 1 });
  const input: NonNullable<NonNullable<DreamingConfig["stages"]>["project"]> = {
    ...(maxProfileDurables !== undefined ? { maxProfileDurables } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: {
      maxProfileDurables: maxProfileDurables ?? defaults.maxProfileDurables,
    },
  };
}

/**
 * Parses the nested `dreaming.stages.prune` block.
 *
 * @param value - Raw prune config value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Canonical persisted values plus the resolved runtime block.
 */
function parseDreamingPruneConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: NonNullable<NonNullable<DreamingConfig["stages"]>["prune"]>; resolved: ResolvedDreamingPruneConfig } {
  const defaults = createDefaultDreamingPruneConfig();
  if (value === undefined) {
    return { resolved: defaults };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: defaults };
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["protectRecalledDays", "protectMinImportance"]), path, issues);

  const protectRecalledDays = parseOptionalIntegerInRange(value.protectRecalledDays, `${path}.protectRecalledDays`, issues, { min: 0 });
  const protectMinImportance = parseOptionalIntegerInRange(value.protectMinImportance, `${path}.protectMinImportance`, issues, { min: 0 });

  if (issues.length > startIndex) {
    return { resolved: defaults };
  }

  const input: NonNullable<NonNullable<DreamingConfig["stages"]>["prune"]> = {
    ...(protectRecalledDays !== undefined ? { protectRecalledDays } : {}),
    ...(protectMinImportance !== undefined ? { protectMinImportance } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: {
      protectRecalledDays: protectRecalledDays ?? defaults.protectRecalledDays,
      protectMinImportance: protectMinImportance ?? defaults.protectMinImportance,
    },
  };
}

/**
 * Parses the nested `dreaming.stages.reap` block.
 *
 * @param value - Raw reap config value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Canonical persisted values plus the resolved runtime block.
 */
function parseDreamingReapConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: NonNullable<NonNullable<DreamingConfig["stages"]>["reap"]>; resolved: ResolvedDreamingReapConfig } {
  const defaults = createDefaultDreamingReapConfig();
  if (value === undefined) {
    return { resolved: defaults };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: defaults };
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["workingSetRetentionDays"]), path, issues);

  const workingSetRetentionDays = parseOptionalIntegerInRange(value.workingSetRetentionDays, `${path}.workingSetRetentionDays`, issues, { min: 0 });

  if (issues.length > startIndex) {
    return { resolved: defaults };
  }

  const input: NonNullable<NonNullable<DreamingConfig["stages"]>["reap"]> = {
    ...(workingSetRetentionDays !== undefined ? { workingSetRetentionDays } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: {
      workingSetRetentionDays: workingSetRetentionDays ?? defaults.workingSetRetentionDays,
    },
  };
}

/** Parses background trigger settings for dreaming. */
function parseDreamingTriggersConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: NonNullable<DreamingConfig["triggers"]>; resolved: ResolvedDreamingConfig["triggers"] } {
  const defaults = createDefaultDreamingConfig().triggers;
  if (value === undefined) {
    return { resolved: defaults };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: defaults };
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["postSessionLightDream", "importanceThreshold", "minIntervalMinutes"]), path, issues);
  const postSessionLightDream = parseOptionalBoolean(value.postSessionLightDream, `${path}.postSessionLightDream`, issues);
  const importanceThreshold = parseOptionalIntegerInRange(value.importanceThreshold, `${path}.importanceThreshold`, issues, { min: 0 });
  const minIntervalMinutes = parseOptionalIntegerInRange(value.minIntervalMinutes, `${path}.minIntervalMinutes`, issues, { min: 0 });

  if (issues.length > startIndex) {
    return { resolved: defaults };
  }

  const input: NonNullable<DreamingConfig["triggers"]> = {
    ...(postSessionLightDream !== undefined ? { postSessionLightDream } : {}),
    ...(importanceThreshold !== undefined ? { importanceThreshold } : {}),
    ...(minIntervalMinutes !== undefined ? { minIntervalMinutes } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: {
      postSessionLightDream: postSessionLightDream ?? defaults.postSessionLightDream,
      importanceThreshold: importanceThreshold ?? defaults.importanceThreshold,
      minIntervalMinutes: minIntervalMinutes ?? defaults.minIntervalMinutes,
    },
  };
}
/**
 * Parses an optional non-negative number.
 *
 * @param value - Raw candidate value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Parsed number, or undefined when absent or invalid.
 */
function parseOptionalNonNegativeNumber(value: unknown, path: string, issues: ValidationIssue[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    pushIssue(issues, path, "Expected a non-negative number.");
    return undefined;
  }

  return value;
}

/**
 * Builds the fully resolved default dreaming config.
 *
 * @returns Default dreaming settings used when config omits the block.
 */
export function createDefaultDreamingConfig(): ResolvedDreamingConfig {
  return {
    dailyCostCap: DEFAULT_DREAMING_DAILY_COST_CAP,
    tiers: {
      light: { enabled: true },
      standard: { enabled: true },
      deep: { enabled: true, intervalHours: DEFAULT_DREAMING_DEEP_INTERVAL_HOURS },
    },
    stages: {
      extract: {
        maxSessionsPerRun: DEFAULT_DREAMING_EXTRACT_MAX_SESSIONS,
        lightMaxSessionsPerRun: DEFAULT_DREAMING_LIGHT_MAX_SESSIONS,
        contextLookup: {
          enabled: true,
        },
      },
      project: { maxProfileDurables: DEFAULT_DREAMING_MAX_PROFILE_DURABLES },
      prune: createDefaultDreamingPruneConfig(),
      reap: createDefaultDreamingReapConfig(),
    },
    triggers: {
      postSessionLightDream: true,
      importanceThreshold: DEFAULT_DREAMING_IMPORTANCE_THRESHOLD,
      minIntervalMinutes: DEFAULT_DREAMING_MIN_INTERVAL_MINUTES,
    },
  };
}

/**
 * Returns the default prune-stage config.
 *
 * @returns Prune-stage defaults used at runtime.
 */
function createDefaultDreamingPruneConfig(): ResolvedDreamingPruneConfig {
  return {
    protectRecalledDays: DEFAULT_DREAMING_PRUNE_PROTECT_RECALLED_DAYS,
    protectMinImportance: DEFAULT_DREAMING_PRUNE_PROTECT_MIN_IMPORTANCE,
  };
}

/**
 * Returns the default reap-stage config.
 *
 * @returns Reap-stage defaults used at runtime.
 */
function createDefaultDreamingReapConfig(): ResolvedDreamingReapConfig {
  return {
    workingSetRetentionDays: DEFAULT_DREAMING_WORKING_SET_RETENTION_DAYS,
  };
}

/**
 * Returns whether a dreaming input block contains persisted values.
 *
 * @param value - Candidate dreaming block.
 * @returns True when the block should be persisted.
 */
function hasDreamingInput(value: DreamingConfig): boolean {
  return (
    hasModelConfig(value.model) ||
    value.dailyCostCap !== undefined ||
    value.tiers !== undefined ||
    value.stages?.extract !== undefined ||
    value.stages?.project !== undefined ||
    value.stages?.prune !== undefined ||
    value.stages?.reap !== undefined ||
    value.triggers !== undefined
  );
}

/**
 * Converts resolved dreaming settings back into the sparse persisted shape.
 *
 * @param value - Resolved dreaming settings.
 * @returns Sparse persisted shape, or undefined when all defaults apply.
 */
export function toDreamingInput(value: ResolvedDreamingConfig): DreamingConfig | undefined {
  const tiers = value.tiers;
  const tiersInput: NonNullable<DreamingConfig["tiers"]> = {
    ...(tiers.light.enabled !== true ? { light: { enabled: tiers.light.enabled } } : {}),
    ...(tiers.standard.enabled !== true ? { standard: { enabled: tiers.standard.enabled } } : {}),
    ...(tiers.deep.enabled !== true || tiers.deep.intervalHours !== DEFAULT_DREAMING_DEEP_INTERVAL_HOURS
      ? {
          deep: {
            ...(tiers.deep.enabled !== true ? { enabled: tiers.deep.enabled } : {}),
            ...(tiers.deep.intervalHours !== DEFAULT_DREAMING_DEEP_INTERVAL_HOURS ? { intervalHours: tiers.deep.intervalHours } : {}),
          },
        }
      : {}),
  };

  const extract = value.stages.extract;
  const contextLookup = extract.contextLookup;
  const contextLookupInput: NonNullable<NonNullable<NonNullable<DreamingConfig["stages"]>["extract"]>["contextLookup"]> = {
    ...(contextLookup.enabled !== true ? { enabled: contextLookup.enabled } : {}),
  };
  const extractInput: NonNullable<NonNullable<DreamingConfig["stages"]>["extract"]> = {
    ...(extract.maxSessionsPerRun !== DEFAULT_DREAMING_EXTRACT_MAX_SESSIONS ? { maxSessionsPerRun: extract.maxSessionsPerRun } : {}),
    ...(extract.lightMaxSessionsPerRun !== DEFAULT_DREAMING_LIGHT_MAX_SESSIONS ? { lightMaxSessionsPerRun: extract.lightMaxSessionsPerRun } : {}),
    ...(Object.keys(contextLookupInput).length > 0 ? { contextLookup: contextLookupInput } : {}),
  };

  const project = value.stages.project;
  const projectInput: NonNullable<NonNullable<DreamingConfig["stages"]>["project"]> = {
    ...(project.maxProfileDurables !== DEFAULT_DREAMING_MAX_PROFILE_DURABLES ? { maxProfileDurables: project.maxProfileDurables } : {}),
  };

  const prune = value.stages.prune;
  const pruneInput: NonNullable<NonNullable<DreamingConfig["stages"]>["prune"]> = {
    ...(prune.protectRecalledDays !== DEFAULT_DREAMING_PRUNE_PROTECT_RECALLED_DAYS ? { protectRecalledDays: prune.protectRecalledDays } : {}),
    ...(prune.protectMinImportance !== DEFAULT_DREAMING_PRUNE_PROTECT_MIN_IMPORTANCE ? { protectMinImportance: prune.protectMinImportance } : {}),
  };

  const reap = value.stages.reap;
  const reapInput: NonNullable<NonNullable<DreamingConfig["stages"]>["reap"]> = {
    ...(reap.workingSetRetentionDays !== DEFAULT_DREAMING_WORKING_SET_RETENTION_DAYS ? { workingSetRetentionDays: reap.workingSetRetentionDays } : {}),
  };

  const triggers = value.triggers;
  const triggersInput: NonNullable<DreamingConfig["triggers"]> = {
    ...(triggers.postSessionLightDream !== true ? { postSessionLightDream: triggers.postSessionLightDream } : {}),
    ...(triggers.importanceThreshold !== DEFAULT_DREAMING_IMPORTANCE_THRESHOLD ? { importanceThreshold: triggers.importanceThreshold } : {}),
    ...(triggers.minIntervalMinutes !== DEFAULT_DREAMING_MIN_INTERVAL_MINUTES ? { minIntervalMinutes: triggers.minIntervalMinutes } : {}),
  };

  const stagesInput: NonNullable<DreamingConfig["stages"]> = {
    ...(Object.keys(extractInput).length > 0 ? { extract: extractInput } : {}),
    ...(Object.keys(projectInput).length > 0 ? { project: projectInput } : {}),
    ...(Object.keys(pruneInput).length > 0 ? { prune: pruneInput } : {}),
    ...(Object.keys(reapInput).length > 0 ? { reap: reapInput } : {}),
  };

  const input: DreamingConfig = {
    ...(hasModelConfig(value.model) ? { model: value.model } : {}),
    ...(value.dailyCostCap !== DEFAULT_DREAMING_DAILY_COST_CAP ? { dailyCostCap: value.dailyCostCap } : {}),
    ...(Object.keys(tiersInput).length > 0 ? { tiers: tiersInput } : {}),
    ...(Object.keys(stagesInput).length > 0 ? { stages: stagesInput } : {}),
    ...(Object.keys(triggersInput).length > 0 ? { triggers: triggersInput } : {}),
  };

  return hasDreamingInput(input) ? input : undefined;
}
