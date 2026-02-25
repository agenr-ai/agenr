import fs from "node:fs/promises";

import path from "node:path";
import { createHash } from "node:crypto";
import { parseTranscriptFile } from "../parser.js";
import { extractKnowledgeFromChunks, SYSTEM_PROMPT } from "../extractor.js";
import { createLlmClient } from "../llm/client.js";
import { APP_VERSION } from "../version.js";
import { scoreSession } from "../benchmark/scorer.js";
import type { BenchmarkResult, BenchmarkRubric, SessionRunResult } from "../benchmark/types.js";
import type { ExtractChunksResult } from "../extractor.js";
import type { KnowledgeEntry } from "../types.js";

const DEFAULT_FIXTURE_DIR = "test/fixtures/benchmark-sessions";
const DEFAULT_RUNS = 1;
const BENCHMARK_TEMPERATURE = 0;

interface BenchmarkSessionFixture {
  session: string;
  fixturePath: string;
  rubricPath: string;
  rubric: BenchmarkRubric;
}

export interface BenchmarkCommandOptions {
  model?: string;
  provider?: string;
  logDir?: string;
  session?: string;
  runs?: number | string;
  json?: boolean;
  verbose?: boolean;
  userOnly?: boolean;
  context?: string;
}

export interface BenchmarkCommandDeps {
  readdirFn: typeof fs.readdir;
  readFileFn: typeof fs.readFile;
  parseTranscriptFileFn: typeof parseTranscriptFile;
  extractKnowledgeFromChunksFn: typeof extractKnowledgeFromChunks;
  createLlmClientFn: typeof createLlmClient;
}

function parsePositiveInt(value: number | string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === null || String(value).trim().length === 0) {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return Math.floor(parsed);
}

function formatMetric(value: number): string {
  return value.toFixed(2);
}

function formatCount(value: number): string {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 1e-9) {
    return String(rounded);
  }
  return value.toFixed(1);
}

function shortPreview(entry: KnowledgeEntry | undefined): string {
  if (!entry) {
    return "(no match)";
  }
  const text = `${entry.subject}: ${entry.content}`.replace(/\s+/g, " ").trim();
  if (text.length <= 140) {
    return text;
  }
  return `${text.slice(0, 137)}...`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function basenameWithoutExt(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function normalizeSessionName(value: string): string {
  return basenameWithoutExt(value.trim());
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function stdev(values: number[]): number {
  if (values.length <= 1) {
    return 0;
  }
  const avg = mean(values);
  const variance = values.reduce((acc, value) => {
    const diff = value - avg;
    return acc + diff * diff;
  }, 0) / values.length;
  return Math.sqrt(variance);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseMustExtract(raw: unknown, rubricPath: string): BenchmarkRubric["must_extract"] {
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid rubric (${rubricPath}): must_extract must be an array.`);
  }
  return raw.map((item, index) => {
    if (!isObjectRecord(item)) {
      throw new Error(`Invalid rubric (${rubricPath}): must_extract[${index}] must be an object.`);
    }
    const contentContains = Array.isArray(item.content_contains)
      ? item.content_contains.filter((value): value is string => typeof value === "string")
      : [];
    if (typeof item.type !== "string" || typeof item.subject_contains !== "string" || typeof item.reason !== "string") {
      throw new Error(`Invalid rubric (${rubricPath}): must_extract[${index}] has invalid string fields.`);
    }
    if (typeof item.min_importance !== "number" || !Number.isFinite(item.min_importance)) {
      throw new Error(`Invalid rubric (${rubricPath}): must_extract[${index}].min_importance must be a number.`);
    }
    const maxImportance =
      typeof item.max_importance === "number" && Number.isFinite(item.max_importance)
        ? item.max_importance
        : undefined;
    return {
      type: item.type,
      subject_contains: item.subject_contains,
      content_contains: contentContains,
      min_importance: item.min_importance,
      max_importance: maxImportance,
      reason: item.reason,
    };
  });
}

function parseMustSkip(raw: unknown, rubricPath: string): BenchmarkRubric["must_skip"] {
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid rubric (${rubricPath}): must_skip must be an array.`);
  }
  return raw.map((item, index) => {
    if (!isObjectRecord(item)) {
      throw new Error(`Invalid rubric (${rubricPath}): must_skip[${index}] must be an object.`);
    }
    if (typeof item.pattern !== "string" || typeof item.reason !== "string") {
      throw new Error(`Invalid rubric (${rubricPath}): must_skip[${index}] requires pattern and reason.`);
    }
    return {
      pattern: item.pattern,
      reason: item.reason,
    };
  });
}

function parseAcceptableRange(raw: unknown, rubricPath: string): BenchmarkRubric["acceptable_range"] {
  if (!isObjectRecord(raw)) {
    throw new Error(`Invalid rubric (${rubricPath}): acceptable_range must be an object.`);
  }
  if (typeof raw.min !== "number" || typeof raw.max !== "number") {
    throw new Error(`Invalid rubric (${rubricPath}): acceptable_range.min/max must be numbers.`);
  }
  return {
    min: raw.min,
    max: raw.max,
  };
}

function parseImportanceCeiling(raw: unknown): BenchmarkRubric["importance_ceiling"] {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (!isObjectRecord(raw)) {
    return undefined;
  }
  if (typeof raw.max_allowed !== "number" || !Number.isFinite(raw.max_allowed)) {
    return undefined;
  }
  return {
    max_allowed: raw.max_allowed,
    reason: typeof raw.reason === "string" ? raw.reason : undefined,
  };
}

function parseRubric(raw: string, rubricPath: string): BenchmarkRubric {
  const parsed = JSON.parse(raw) as unknown;
  if (!isObjectRecord(parsed)) {
    throw new Error(`Invalid rubric (${rubricPath}): expected JSON object.`);
  }
  if (typeof parsed.session !== "string" || typeof parsed.description !== "string") {
    throw new Error(`Invalid rubric (${rubricPath}): session and description are required.`);
  }
  return {
    session: parsed.session,
    description: parsed.description,
    must_extract: parseMustExtract(parsed.must_extract, rubricPath),
    must_skip: parseMustSkip(parsed.must_skip, rubricPath),
    acceptable_range: parseAcceptableRange(parsed.acceptable_range, rubricPath),
    importance_ceiling: parseImportanceCeiling(parsed.importance_ceiling),
    notes: typeof parsed.notes === "string" ? parsed.notes : undefined,
  };
}

async function discoverFixtures(
  fixtureDir: string,
  deps: Pick<BenchmarkCommandDeps, "readdirFn" | "readFileFn">,
): Promise<BenchmarkSessionFixture[]> {
  const entries = await deps.readdirFn(fixtureDir, { withFileTypes: true });
  const fixtureFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(fixtureDir, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  if (fixtureFiles.length === 0) {
    throw new Error(`No fixture files found in ${fixtureDir}.`);
  }

  const sessions: BenchmarkSessionFixture[] = [];
  for (const fixturePath of fixtureFiles) {
    const session = basenameWithoutExt(fixturePath);
    const rubricPath = path.join(fixtureDir, "expected", `${session}.json`);
    const rubricRaw = await deps.readFileFn(rubricPath, "utf8");
    const rubric = parseRubric(rubricRaw, rubricPath);
    sessions.push({
      session,
      fixturePath,
      rubricPath,
      rubric,
    });
  }
  return sessions;
}

async function computeFixtureHash(
  fixtures: BenchmarkSessionFixture[],
  readFileFn: BenchmarkCommandDeps["readFileFn"],
): Promise<string> {
  const sorted = [...fixtures].sort((a, b) => a.session.localeCompare(b.session));
  const hasher = createHash("sha256");
  for (const fixture of sorted) {
    const content = await readFileFn(fixture.fixturePath, "utf8");
    hasher.update(content);
  }
  return hasher.digest("hex");
}

function isTemperatureUnsupportedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("temperature") && (message.includes("unsupported") || message.includes("not supported"));
}

async function runExtraction(
  params: {
    fixturePath: string;
    verbose: boolean;
    logDir?: string;
    client: ReturnType<typeof createLlmClient>;
    userOnly?: boolean;
    context?: string;
  },
  deps: Pick<BenchmarkCommandDeps, "parseTranscriptFileFn" | "extractKnowledgeFromChunksFn">,
): Promise<{ result: ExtractChunksResult; temperatureUnsupported: boolean }> {
  const parsed = await deps.parseTranscriptFileFn(params.fixturePath, { verbose: params.verbose });

  // Filter to user messages only if requested
  let messages = parsed.messages;
  if (params.userOnly) {
    messages = messages.filter((m) => m.role === "user");
  }

  // Re-chunk filtered messages
  const chunks = params.userOnly
    ? messages.length === 0
      ? []
      : [{
          chunk_index: 0,
          message_start: messages[0]?.index ?? 0,
          message_end: messages[messages.length - 1]?.index ?? 0,
          text: messages.map((m) => `[m${m.index}][${m.role}] ${m.text}`).join("\n"),
          context_hint: "",
          timestamp_start: messages[0]?.timestamp,
          timestamp_end: messages[messages.length - 1]?.timestamp,
        }]
    : parsed.chunks;

  // Build context prefix for system prompt override
  const contextPrefix = params.context
    ? `\n\n=== KNOWN CONTEXT (already stored - do NOT re-extract these facts) ===\n${params.context}\n=== END KNOWN CONTEXT ===\n\nExtract ONLY new facts not already covered above.\n\n`
    : "";

  const runWithTemp = async (temperature: number | undefined): Promise<ExtractChunksResult> =>
    chunks.length === 0
      ? {
          entries: [],
          successfulChunks: 0,
          failedChunks: 0,
          warnings: [],
        }
      : deps.extractKnowledgeFromChunksFn({
          file: params.fixturePath,
          chunks,
          messages,
          client: params.client,
          verbose: params.verbose,
          wholeFile: "force",
          temperature,
          logAll: Boolean(params.logDir),
          logDir: params.logDir,
          noDedup: true,
          ...(contextPrefix ? { systemPromptPrefix: contextPrefix } : {}),
        });

  try {
    const result = await runWithTemp(BENCHMARK_TEMPERATURE);
    return { result, temperatureUnsupported: false };
  } catch (error) {
    if (!isTemperatureUnsupportedError(error)) {
      throw error;
    }
    const fallbackResult = await runWithTemp(undefined);
    return { result: fallbackResult, temperatureUnsupported: true };
  }
}

function renderSummary(
  result: BenchmarkResult,
  rangesBySession: Map<string, { min: number; max: number }>,
): void {
  const sessionWidth = Math.max(
    "Session".length,
    ...result.sessions.map((session) => session.session.length),
  );
  const lines: string[] = [];
  lines.push("Benchmark Results");
  lines.push("=================");
  lines.push(
    `Model: ${result.model} | Temp: ${result.temperature} | Runs: ${result.runs} | Version: ${result.agenr_version}`,
  );
  lines.push("");

  const header =
    `${"Session".padEnd(sessionWidth)}  ` +
    "Recall  P-Recall  Precision  Composite  Count      Pass";
  lines.push(header);

  for (const session of result.sessions) {
    const range = rangesBySession.get(session.session);
    const avgEntryCount = mean(session.runs.map((run) => run.total_entries));
    const countLabel =
      range !== undefined
        ? `${formatCount(avgEntryCount)}/${range.min}-${range.max}`
        : `${formatCount(avgEntryCount)}/-`;
    const passCount = session.runs.filter((run) => run.pass).length;

    lines.push(
      `${session.session.padEnd(sessionWidth)}  ` +
        `${formatMetric(session.mean_recall).padEnd(6)}  ` +
        `${formatMetric(session.mean_partial_recall).padEnd(8)}  ` +
        `${formatMetric(session.mean_precision).padEnd(9)}  ` +
        `${formatMetric(session.mean_composite).padEnd(9)}  ` +
        `${countLabel.padEnd(9)}  ` +
        `${passCount}/${result.runs}`,
    );
  }

  lines.push("=================");
  lines.push(
    `Overall: ${result.overall.pass_count}/${result.overall.total_sessions} passed | ` +
      `Composite: ${formatMetric(result.overall.mean_composite)} | ` +
      `Recall: ${formatMetric(result.overall.mean_recall)} | ` +
      `Precision: ${formatMetric(result.overall.mean_precision)}`,
  );

  process.stdout.write(`${lines.join("\n")}\n`);
}

function renderVerboseDetails(result: BenchmarkResult): void {
  process.stdout.write("\nDetails\n=======\n");
  for (const session of result.sessions) {
    process.stdout.write(`\n${session.session}\n`);
    process.stdout.write(`Pass rate: ${Math.round(session.pass_rate * 100)}% (${session.runs.filter((run) => run.pass).length}/${result.runs})\n`);
    if (result.runs > 1) {
      process.stdout.write(
        `Variance: mean=${formatMetric(session.mean_composite)}, min=${formatMetric(session.min_composite)}, stdev=${formatMetric(session.stdev_composite)}\n`,
      );
    }

    for (const [runIndex, run] of session.runs.entries()) {
      process.stdout.write(
        `\n  Run ${runIndex + 1}: recall=${formatMetric(run.recall)} partial=${formatMetric(run.partial_recall)} precision=${formatMetric(run.precision_proxy)} composite=${formatMetric(run.composite_score)} pass=${run.pass}\n`,
      );

      for (const [ruleIndex, score] of run.must_extract_scores.entries()) {
        process.stdout.write(
          `    must_extract[${ruleIndex + 1}] ${score.matched ? "HIT" : "MISS"} ` +
            `score=${formatMetric(score.partial_score)} ` +
            `(type=${score.type_match ? "y" : "n"}, subject=${score.subject_match ? "y" : "n"}, content=${formatMetric(score.content_match)}, importance=${score.importance_match ? "y" : "n"})\n`,
        );
        process.stdout.write(`      reason: ${score.rule.reason}\n`);
        process.stdout.write(`      match: ${shortPreview(score.matched_entry)}\n`);
      }

      if (run.must_skip_violations.length > 0) {
        process.stdout.write(`    must_skip violations (${run.must_skip_violations.length})\n`);
        for (const violation of run.must_skip_violations) {
          process.stdout.write(`      pattern: ${violation.rule.pattern}\n`);
          process.stdout.write(`      entry: ${shortPreview(violation.violating_entry)}\n`);
        }
      }

      if ((run.importance_violations?.length ?? 0) > 0) {
        process.stdout.write(`    importance ceiling violations (${run.importance_violations?.length ?? 0})\n`);
        for (const entry of run.importance_violations ?? []) {
          process.stdout.write(`      imp=${entry.importance} ${shortPreview(entry)}\n`);
        }
      }
    }
  }
}

export async function runBenchmarkCommand(
  options: BenchmarkCommandOptions,
  deps?: Partial<BenchmarkCommandDeps>,
): Promise<{ exitCode: number; result: BenchmarkResult }> {
  const resolvedDeps: BenchmarkCommandDeps = {
    readdirFn: deps?.readdirFn ?? fs.readdir,
    readFileFn: deps?.readFileFn ?? fs.readFile,
    parseTranscriptFileFn: deps?.parseTranscriptFileFn ?? parseTranscriptFile,
    extractKnowledgeFromChunksFn: deps?.extractKnowledgeFromChunksFn ?? extractKnowledgeFromChunks,
    createLlmClientFn: deps?.createLlmClientFn ?? createLlmClient,
  };

  const runs = parsePositiveInt(options.runs, DEFAULT_RUNS, "--runs");
  const fixtureRoot = path.resolve(DEFAULT_FIXTURE_DIR);
  const allFixtures = await discoverFixtures(fixtureRoot, resolvedDeps);

  const sessionFilter = options.session ? normalizeSessionName(options.session) : null;
  const selectedFixtures = sessionFilter
    ? allFixtures.filter((fixture) => fixture.session === sessionFilter)
    : allFixtures;
  if (selectedFixtures.length === 0) {
    const available = allFixtures.map((fixture) => fixture.session).join(", ");
    throw new Error(`No benchmark session found for "${options.session}". Available: ${available}`);
  }

  const client = resolvedDeps.createLlmClientFn({
    provider: options.provider,
    model: options.model,
    env: process.env,
  });

  // Load context file if provided
  let contextContent: string | undefined;
  if (options.context) {
    try {
      contextContent = await resolvedDeps.readFileFn(options.context, "utf8");
    } catch (err) {
      throw new Error(`Failed to read context file "${options.context}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const promptHash = sha256(SYSTEM_PROMPT);
  const fixtureHash = await computeFixtureHash(selectedFixtures, resolvedDeps.readFileFn);
  const rangesBySession = new Map<string, { min: number; max: number }>();
  let warnedTemperatureUnsupported = false;
  const sessionResults: SessionRunResult[] = [];

  for (const fixture of selectedFixtures) {
    rangesBySession.set(fixture.session, fixture.rubric.acceptable_range);
    const runScores = [];

    for (let runIndex = 0; runIndex < runs; runIndex += 1) {
      const runLogDir =
        options.logDir && options.logDir.trim().length > 0
          ? path.resolve(
              runs > 1
                ? path.join(options.logDir, `run-${runIndex + 1}`, fixture.session)
                : path.join(options.logDir, fixture.session),
            )
          : undefined;

      const extraction = await runExtraction(
        {
          fixturePath: fixture.fixturePath,
          verbose: options.verbose === true,
          logDir: runLogDir,
          client,
          userOnly: options.userOnly,
          context: contextContent,
        },
        resolvedDeps,
      );

      if (extraction.temperatureUnsupported && !warnedTemperatureUnsupported) {
        process.stderr.write(
          "[benchmark] Warning: model/provider does not support temperature control. Continuing without explicit temperature.\n",
        );
        warnedTemperatureUnsupported = true;
      }

      const score = scoreSession(extraction.result.entries, fixture.rubric);
      runScores.push(score);
    }

    const composites = runScores.map((run) => run.composite_score);
    const recalls = runScores.map((run) => run.recall);
    const partialRecalls = runScores.map((run) => run.partial_recall);
    const precisions = runScores.map((run) => run.precision_proxy);
    const passCount = runScores.filter((run) => run.pass).length;

    sessionResults.push({
      session: fixture.session,
      runs: runScores,
      mean_composite: mean(composites),
      min_composite: Math.min(...composites),
      stdev_composite: stdev(composites),
      mean_recall: mean(recalls),
      mean_partial_recall: mean(partialRecalls),
      mean_precision: mean(precisions),
      pass_rate: runScores.length === 0 ? 0 : passCount / runScores.length,
    });
  }

  const result: BenchmarkResult = {
    model: client.resolvedModel.modelId,
    temperature: warnedTemperatureUnsupported ? null : BENCHMARK_TEMPERATURE,
    runs,
    agenr_version: APP_VERSION,
    prompt_hash: promptHash,
    fixture_hash: fixtureHash,
    sessions: sessionResults,
    overall: {
      pass_count: sessionResults.filter((session) => session.pass_rate === 1).length,
      total_sessions: sessionResults.length,
      mean_composite: mean(sessionResults.map((session) => session.mean_composite)),
      mean_recall: mean(sessionResults.map((session) => session.mean_recall)),
      mean_partial_recall: mean(sessionResults.map((session) => session.mean_partial_recall)),
      mean_precision: mean(sessionResults.map((session) => session.mean_precision)),
    },
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    renderSummary(result, rangesBySession);
    if (options.verbose) {
      renderVerboseDetails(result);
    }
  }

  const allRunsPassed = sessionResults.every((session) => session.pass_rate === 1);
  return {
    exitCode: allRunsPassed ? 0 : 1,
    result,
  };
}
