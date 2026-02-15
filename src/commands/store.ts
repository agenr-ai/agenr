import fs from "node:fs/promises";
import path from "node:path";
import * as clack from "@clack/prompts";
import { readConfig } from "../config.js";
import { closeDb, getDb, initDb } from "../db/client.js";
import { hashText, storeEntries } from "../db/store.js";
import { resolveEmbeddingApiKey } from "../embeddings/client.js";
import { createLlmClient } from "../llm/client.js";
import { expandInputFiles } from "../parser.js";
import { CONFIDENCE_LEVELS, EXPIRY_LEVELS, KNOWLEDGE_TYPES } from "../types.js";
import type { ExtractionReport, KnowledgeEntry, StoreResult } from "../types.js";
import { banner, formatLabel, formatWarn, ui } from "../ui.js";

export interface StoreCommandOptions {
  db?: string;
  dryRun?: boolean;
  verbose?: boolean;
  force?: boolean;
  classify?: boolean;
}

interface StoreInput {
  sourceFile: string;
  contentHash: string;
  entries: KnowledgeEntry[];
}

export interface StoreCommandDeps {
  expandInputFilesFn: typeof expandInputFiles;
  readFileFn: (filePath: string) => Promise<string>;
  readStdinFn: () => Promise<string>;
  readConfigFn: typeof readConfig;
  resolveEmbeddingApiKeyFn: typeof resolveEmbeddingApiKey;
  createLlmClientFn: typeof createLlmClient;
  getDbFn: typeof getDb;
  initDbFn: typeof initDb;
  closeDbFn: typeof closeDb;
  storeEntriesFn: typeof storeEntries;
}

const KNOWLEDGE_TYPE_SET = new Set<string>(KNOWLEDGE_TYPES);
const CONFIDENCE_LEVEL_SET = new Set<string>(CONFIDENCE_LEVELS);
const EXPIRY_LEVEL_SET = new Set<string>(EXPIRY_LEVELS);

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .map((item) => item.toLowerCase()),
    ),
  );
}

function normalizeEntry(raw: unknown, fallbackFile: string): KnowledgeEntry {
  if (!raw || typeof raw !== "object") {
    throw new Error("Entry must be an object.");
  }

  const record = raw as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.trim() : "";
  const subject = typeof record.subject === "string" ? record.subject.trim() : "";
  const content = typeof record.content === "string" ? record.content.trim() : "";

  if (!KNOWLEDGE_TYPE_SET.has(type)) {
    throw new Error(`Invalid entry type: ${String(record.type)}`);
  }
  if (!subject) {
    throw new Error("Entry subject is required.");
  }
  if (!content) {
    throw new Error("Entry content is required.");
  }

  const confidenceRaw = typeof record.confidence === "string" ? record.confidence.trim() : "medium";
  const confidence = CONFIDENCE_LEVEL_SET.has(confidenceRaw) ? confidenceRaw : "medium";

  const expiryRaw = typeof record.expiry === "string" ? record.expiry.trim() : "temporary";
  const expiry = EXPIRY_LEVEL_SET.has(expiryRaw) ? expiryRaw : "temporary";

  const sourceRecord =
    record.source && typeof record.source === "object" ? (record.source as Record<string, unknown>) : null;
  const sourceFile =
    sourceRecord && typeof sourceRecord.file === "string" && sourceRecord.file.trim()
      ? sourceRecord.file.trim()
      : fallbackFile;
  const sourceContext =
    sourceRecord && typeof sourceRecord.context === "string" && sourceRecord.context.trim()
      ? sourceRecord.context.trim()
      : `ingested from ${fallbackFile}`;

  return {
    type: type as KnowledgeEntry["type"],
    subject,
    content,
    confidence: confidence as KnowledgeEntry["confidence"],
    expiry: expiry as KnowledgeEntry["expiry"],
    tags: normalizeTags(record.tags),
    source: {
      file: sourceFile,
      context: sourceContext,
    },
  };
}

function flattenReportEntries(report: ExtractionReport, fallbackFile: string): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  const files = report.files && typeof report.files === "object" ? report.files : {};
  for (const [file, payload] of Object.entries(files)) {
    const record = payload as { entries?: unknown };
    if (!record || !Array.isArray(record.entries)) {
      continue;
    }
    for (const rawEntry of record.entries) {
      entries.push(normalizeEntry(rawEntry, file || fallbackFile));
    }
  }
  return entries;
}

function parseInputJson(raw: string, sourceFile: string): KnowledgeEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse JSON from ${sourceFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (Array.isArray(parsed)) {
    return parsed.map((entry) => normalizeEntry(entry, sourceFile));
  }

  if (parsed && typeof parsed === "object" && "files" in (parsed as Record<string, unknown>)) {
    return flattenReportEntries(parsed as ExtractionReport, sourceFile);
  }

  throw new Error(`Unsupported JSON payload in ${sourceFile}. Expected KnowledgeEntry[] or ExtractionReport.`);
}

function renderDecisionLine(params: {
  sourceFile: string;
  action: "added" | "updated" | "skipped";
  reason: string;
  entry: KnowledgeEntry;
  similarity?: number;
  matchedEntryId?: string;
}): string {
  const similarity =
    typeof params.similarity === "number" ? ` similarity=${params.similarity.toFixed(3)}` : "";
  const matched = params.matchedEntryId ? ` match=${params.matchedEntryId}` : "";
  return `[${params.action}] ${params.sourceFile} ${params.entry.type}:${params.entry.subject} -- ${params.reason}${similarity}${matched}`;
}

export async function runStoreCommand(
  files: string[],
  options: StoreCommandOptions,
  deps?: Partial<StoreCommandDeps>,
): Promise<{ exitCode: number; result: StoreResult }> {
  const resolvedDeps: StoreCommandDeps = {
    expandInputFilesFn: deps?.expandInputFilesFn ?? expandInputFiles,
    readFileFn: deps?.readFileFn ?? ((filePath: string) => fs.readFile(filePath, "utf8")),
    readStdinFn: deps?.readStdinFn ?? readStdin,
    readConfigFn: deps?.readConfigFn ?? readConfig,
    resolveEmbeddingApiKeyFn: deps?.resolveEmbeddingApiKeyFn ?? resolveEmbeddingApiKey,
    createLlmClientFn: deps?.createLlmClientFn ?? createLlmClient,
    getDbFn: deps?.getDbFn ?? getDb,
    initDbFn: deps?.initDbFn ?? initDb,
    closeDbFn: deps?.closeDbFn ?? closeDb,
    storeEntriesFn: deps?.storeEntriesFn ?? storeEntries,
  };

  const clackOutput = { output: process.stderr };
  clack.intro(banner(), clackOutput);

  const inputs: StoreInput[] = [];
  const expandedFiles = files.length > 0 ? await resolvedDeps.expandInputFilesFn(files) : [];

  if (files.length > 0 && expandedFiles.length === 0) {
    throw new Error("No input files matched.");
  }

  for (const inputPath of expandedFiles) {
    const resolvedPath = path.resolve(inputPath);
    let raw: string;
    try {
      raw = await resolvedDeps.readFileFn(resolvedPath);
    } catch (error) {
      throw new Error(
        `Failed to read input file ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    inputs.push({
      sourceFile: resolvedPath,
      contentHash: hashText(raw),
      entries: parseInputJson(raw, resolvedPath),
    });
  }

  if (!process.stdin.isTTY) {
    const rawStdin = await resolvedDeps.readStdinFn();
    const normalizedRaw = rawStdin.trim();
    if (normalizedRaw.length > 0) {
      const stdinHash = hashText(normalizedRaw);
      inputs.push({
        sourceFile: `stdin:${stdinHash}`,
        contentHash: stdinHash,
        entries: parseInputJson(normalizedRaw, `stdin:${stdinHash}`),
      });
    }
  }

  if (inputs.length === 0) {
    throw new Error("No input provided. Pass JSON files and/or pipe JSON via stdin.");
  }

  const totalInputEntries = inputs.reduce((sum, input) => sum + input.entries.length, 0);
  clack.log.info(
    `Storing ${ui.bold(String(totalInputEntries))} entries from ${ui.bold(String(inputs.length))} input(s)`,
    clackOutput,
  );

  const config = resolvedDeps.readConfigFn(process.env);
  const hasAnyEntries = totalInputEntries > 0;
  const apiKey = hasAnyEntries ? resolvedDeps.resolveEmbeddingApiKeyFn(config, process.env) : "";
  const llmClient = options.classify && hasAnyEntries ? resolvedDeps.createLlmClientFn({ env: process.env }) : undefined;

  const dbPath = options.db?.trim() || config?.db?.path;
  const db = resolvedDeps.getDbFn(dbPath);

  try {
    await resolvedDeps.initDbFn(db);

    let added = 0;
    let updated = 0;
    let skipped = 0;
    let relationsCreated = 0;
    let durationMs = 0;
    let totalEntries = 0;

    for (const input of inputs) {
      const result = await resolvedDeps.storeEntriesFn(db, input.entries, apiKey, {
        dryRun: options.dryRun,
        force: options.force,
        verbose: options.verbose,
        classify: options.classify,
        llmClient,
        sourceFile: input.sourceFile,
        ingestContentHash: input.contentHash,
        onDecision: options.verbose
          ? (decision) => {
              clack.log.info(
                renderDecisionLine({
                  sourceFile: input.sourceFile,
                  action: decision.action,
                  reason: decision.reason,
                  entry: decision.entry,
                  similarity: decision.similarity,
                  matchedEntryId: decision.matchedEntryId,
                }),
                clackOutput,
              );
            }
          : undefined,
      });

      added += result.added;
      updated += result.updated;
      skipped += result.skipped;
      relationsCreated += result.relations_created;
      durationMs += result.duration_ms;
      totalEntries = result.total_entries;
    }

    const finalResult: StoreResult = {
      added,
      updated,
      skipped,
      relations_created: relationsCreated,
      total_entries: totalEntries,
      duration_ms: durationMs,
    };

    clack.note(
      [
        formatLabel("New", `${finalResult.added} entries added`),
        formatLabel("Updated", `${finalResult.updated} entries updated`),
        formatLabel("Skipped", `${finalResult.skipped} duplicates`),
        formatLabel("Relations", `${finalResult.relations_created} created`),
        formatLabel("Database", `${finalResult.total_entries} total entries`),
        options.dryRun ? formatWarn("dry-run: no changes persisted") : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
      "Store Complete",
      clackOutput,
    );

    clack.outro(undefined, clackOutput);
    return { exitCode: 0, result: finalResult };
  } finally {
    resolvedDeps.closeDbFn(db);
  }
}
