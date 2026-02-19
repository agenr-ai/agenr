import fs from "node:fs/promises";
import path from "node:path";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { formatAuthSummary, getAuthStatus, getQuickStatus } from "./auth-status.js";
import { parseIntOption } from "./cli/option-parsers.js";
import {
  runDbExportCommand,
  runDbCheckCommand,
  runDbPathCommand,
  runDbRebuildIndexCommand,
  runDbResetCommand,
  runDbStatsCommand,
  runDbVersionCommand,
} from "./commands/db.js";
import {
  runDaemonInstallCommand,
  runDaemonLogsCommand,
  runDaemonRestartCommand,
  runDaemonStartCommand,
  runDaemonStatusCommand,
  runDaemonStopCommand,
  runDaemonUninstallCommand,
} from "./commands/daemon.js";
import { runConsolidateCommand } from "./commands/consolidate.js";
import { runEvalRecallCommand } from "./commands/eval.js";
import { runHealthCommand } from "./commands/health.js";
import { runIngestCommand } from "./commands/ingest.js";
import { runContextCommand } from "./commands/context.js";
import { runMcpCommand } from "./commands/mcp.js";
import { runRecallCommand } from "./commands/recall.js";
import { runRetireCommand } from "./commands/retire.js";
import { runStoreCommand } from "./commands/store.js";
import { runTodoCommand } from "./commands/todo.js";
import { runWatchCommand } from "./commands/watch.js";
import { describeAuth, maskSecret, readConfig, setConfigKey, setStoredCredential, writeConfig } from "./config.js";
import { deduplicateEntries } from "./dedup.js";
import { extractKnowledgeFromChunks } from "./extractor.js";
import { createLlmClient } from "./llm/client.js";
import { probeCredentials } from "./llm/credentials.js";
import { writeOutput } from "./output.js";
import { expandInputFiles, parseTranscriptFile } from "./parser.js";
import { runSetup } from "./setup.js";
import { banner, formatError, formatLabel, formatSuccess, formatWarn, ui } from "./ui.js";
import { APP_VERSION } from "./version.js";
import type { ExtractionReport, ExtractionStats } from "./types.js";
import type { ConsolidateCommandOptions } from "./commands/consolidate.js";
import type { DaemonInstallOptions, DaemonLogsOptions, DaemonStatusOptions, DaemonUninstallOptions } from "./commands/daemon.js";
import type { IngestCommandOptions } from "./commands/ingest.js";
import type { WatchCommandOptions } from "./commands/watch.js";

export interface ExtractCommandOptions {
  format: "json" | "markdown";
  json?: boolean;
  output?: string;
  split?: boolean;
  model?: string;
  provider?: string;
  verbose?: boolean;
  noDedup?: boolean;
}

export interface CliDeps {
  expandInputFilesFn: typeof expandInputFiles;
  assertReadableFileFn: (filePath: string) => Promise<void>;
  parseTranscriptFileFn: typeof parseTranscriptFile;
  createLlmClientFn: typeof createLlmClient;
  extractKnowledgeFromChunksFn: typeof extractKnowledgeFromChunks;
  deduplicateEntriesFn: typeof deduplicateEntries;
  writeOutputFn: typeof writeOutput;
}

function stderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function assertReadableFile(filePath: string): Promise<void> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Input is not a file: ${filePath}`);
  }
  await fs.access(filePath);
}

function createEmptyStats(warnings: string[] = []): ExtractionStats {
  return {
    chunks: 0,
    successful_chunks: 0,
    failed_chunks: 0,
    raw_entries: 0,
    deduped_entries: 0,
    warnings,
  };
}

function toReportKey(filePath: string, used: Set<string>): string {
  const relative = path.relative(process.cwd(), filePath) || path.basename(filePath);
  if (!used.has(relative)) {
    used.add(relative);
    return relative;
  }

  let i = 2;
  while (true) {
    const candidate = `${relative}#${i}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    i += 1;
  }
}

export async function runExtractCommand(
  files: string[],
  options: ExtractCommandOptions,
  deps?: Partial<CliDeps>,
): Promise<{ exitCode: number; report?: ExtractionReport; writtenPaths: string[] }> {
  const verbose = options.verbose === true;
  const resolvedDeps: CliDeps = {
    expandInputFilesFn: deps?.expandInputFilesFn ?? expandInputFiles,
    assertReadableFileFn: deps?.assertReadableFileFn ?? assertReadableFile,
    parseTranscriptFileFn: deps?.parseTranscriptFileFn ?? parseTranscriptFile,
    createLlmClientFn: deps?.createLlmClientFn ?? createLlmClient,
    extractKnowledgeFromChunksFn: deps?.extractKnowledgeFromChunksFn ?? extractKnowledgeFromChunks,
    deduplicateEntriesFn: deps?.deduplicateEntriesFn ?? deduplicateEntries,
    writeOutputFn: deps?.writeOutputFn ?? writeOutput,
  };

  const expanded = await resolvedDeps.expandInputFilesFn(files);
  if (expanded.length === 0) {
    throw new Error("No input files matched.");
  }

  for (const file of expanded) {
    await resolvedDeps.assertReadableFileFn(file);
  }

  const client = resolvedDeps.createLlmClientFn({
    provider: options.provider,
    model: options.model,
    env: process.env,
  });

  const clackOutput = { output: process.stderr };
  clack.intro(banner(), clackOutput);
  clack.log.info(
    "Extracting from " + ui.bold(`${expanded.length} file(s)`) + " using " + ui.bold(client.resolvedModel.modelId),
    clackOutput,
  );

  const fileMap: ExtractionReport["files"] = {};
  const keySet = new Set<string>();

  let summaryChunks = 0;
  let summarySuccessChunks = 0;
  let summaryFailedChunks = 0;
  let summaryRawEntries = 0;
  let summaryDedupedEntries = 0;
  let summaryWarnings = 0;

  const recordSuccess = (params: {
    key: string;
    chunks: number;
    extracted: {
      entries: ExtractionReport["files"][string]["entries"];
      successfulChunks: number;
      failedChunks: number;
      warnings: string[];
    };
    parseWarnings: string[];
  }): ExtractionStats => {
    const deduped = resolvedDeps.deduplicateEntriesFn(params.extracted.entries);
    const warnings = [...params.parseWarnings, ...params.extracted.warnings];

    const stats: ExtractionStats = {
      chunks: params.chunks,
      successful_chunks: params.extracted.successfulChunks,
      failed_chunks: params.extracted.failedChunks,
      raw_entries: params.extracted.entries.length,
      deduped_entries: deduped.length,
      warnings,
    };

    fileMap[params.key] = {
      entries: deduped,
      stats,
    };

    summaryChunks += stats.chunks;
    summarySuccessChunks += stats.successful_chunks;
    summaryFailedChunks += stats.failed_chunks;
    summaryRawEntries += stats.raw_entries;
    summaryDedupedEntries += stats.deduped_entries;
    summaryWarnings += stats.warnings.length;

    return stats;
  };

  const recordFailure = (key: string, error: unknown): string => {
    const warning = `File failed: ${key} (${error instanceof Error ? error.message : String(error)})`;
    fileMap[key] = {
      entries: [],
      stats: createEmptyStats([warning]),
    };
    summaryWarnings += 1;
    return warning;
  };

  if (verbose) {
    for (const [index, file] of expanded.entries()) {
      const key = toReportKey(file, keySet);
      clack.log.info(`${ui.dim(`[${index + 1}/${expanded.length}]`)} ${path.basename(file)}`, clackOutput);

      try {
        const parsed = await resolvedDeps.parseTranscriptFileFn(file);
        clack.log.info(
          `[parse] ${key}: messages=${parsed.messages.length}, chunks=${parsed.chunks.length}`,
          clackOutput,
        );

        const extracted = await resolvedDeps.extractKnowledgeFromChunksFn({
          file: key,
          chunks: parsed.chunks,
          client,
          verbose: true,
          noDedup: options.noDedup === true,
          onVerbose: (line) => clack.log.info(line, clackOutput),
          onStreamDelta: (delta) => process.stderr.write(delta),
        });
        process.stderr.write("\n");

        const stats = recordSuccess({
          key,
          chunks: parsed.chunks.length,
          extracted,
          parseWarnings: parsed.warnings,
        });

        clack.log.info(ui.success(`${stats.deduped_entries} entries (${stats.chunks} chunks)`), clackOutput);
      } catch (error) {
        const warning = recordFailure(key, error);
        clack.log.error(warning, clackOutput);
      }
    }
  } else {
    await clack.tasks(
      expanded.map((file, index) => ({
        title: `${ui.dim(`[${index + 1}/${expanded.length}]`)} ${path.basename(file)}`,
        task: async () => {
          const key = toReportKey(file, keySet);

          try {
            const parsed = await resolvedDeps.parseTranscriptFileFn(file);
            const extracted = await resolvedDeps.extractKnowledgeFromChunksFn({
              file: key,
              chunks: parsed.chunks,
              client,
              verbose: false,
              noDedup: options.noDedup === true,
            });

            const stats = recordSuccess({
              key,
              chunks: parsed.chunks.length,
              extracted,
              parseWarnings: parsed.warnings,
            });

            return `${stats.deduped_entries} entries (${stats.chunks} chunks)`;
          } catch (error) {
            recordFailure(key, error);
            return formatError("processing failed");
          }
        },
      })),
      clackOutput,
    );
  }

  const report: ExtractionReport = {
    version: APP_VERSION,
    extracted_at: new Date().toISOString(),
    provider: client.resolvedModel.provider,
    model: client.resolvedModel.modelId,
    files: fileMap,
    summary: {
      files: Object.keys(fileMap).length,
      chunks: summaryChunks,
      successful_chunks: summarySuccessChunks,
      failed_chunks: summaryFailedChunks,
      raw_entries: summaryRawEntries,
      deduped_entries: summaryDedupedEntries,
      warnings: summaryWarnings,
    },
  };

  const writtenPaths = await resolvedDeps.writeOutputFn({
    report,
    format: options.format,
    output: options.output,
    split: options.split === true,
  });

  clack.note(
    [
      formatLabel("Files", String(report.summary.files)),
      formatLabel("Chunks", `${report.summary.successful_chunks}/${report.summary.chunks} successful`),
      formatLabel(
        "Entries",
        `${report.summary.deduped_entries} entries (${report.summary.raw_entries - report.summary.deduped_entries} duplicates removed)`,
      ),
      report.summary.failed_chunks > 0 ? formatWarn(`${report.summary.failed_chunks} chunks failed`) : null,
      report.summary.warnings > 0 ? formatWarn(`${report.summary.warnings} warning(s)`) : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    "Extraction Complete",
    clackOutput,
  );

  for (const outPath of writtenPaths) {
    clack.log.success("Wrote " + ui.bold(outPath), clackOutput);
  }

  clack.outro(undefined, clackOutput);

  return {
    exitCode: report.summary.successful_chunks > 0 ? 0 : 1,
    report,
    writtenPaths,
  };
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("agenr")
    .description("Memory infrastructure for AI agents")
    .version(APP_VERSION)
    .action(async () => {
      const quick = getQuickStatus(process.env);

      clack.intro(banner());

      if (!quick.configured) {
        clack.note("Not configured", "Status");
        clack.log.warn("Run " + ui.bold("agenr setup") + " to get started.");
      } else if (quick.credentialAvailable) {
        clack.note(
          [
            formatLabel("Provider", quick.provider ?? "(not set)"),
            formatLabel("Model", quick.model ?? "(not set)"),
            formatLabel("Auth", quick.auth ? formatAuthSummary(quick.auth) : "(not set)"),
          ].join("\n"),
          "Ready",
        );
      } else {
        clack.note(
          [
            formatLabel("Provider", quick.provider ?? "(not set)"),
            formatLabel("Model", quick.model ?? "(not set)"),
          ].join("\n"),
          "Not authenticated",
        );
        clack.log.warn(quick.guidance);
      }

      program.outputHelp();
      clack.outro(ui.dim("https://agenr.ai"));
    });

  program
    .command("extract")
    .description("Extract structured knowledge from conversation transcripts")
    .argument("<files...>", "One or more transcript files (.jsonl, .md, .txt)")
    .option("--json", "Output raw KnowledgeEntry[] JSON", false)
    .option("--format <type>", "Output format: json, markdown", "markdown")
    .option("--output <file>", "Write output to file (or directory with --split)")
    .option("--split", "Write one output file per input transcript", false)
    .option("--model <model>", "LLM model to use")
    .option("--provider <name>", "LLM provider: anthropic, openai, openai-codex")
    .option("--no-dedup", "Skip post-extraction LLM dedup pass", false)
    .option("--verbose", "Show extraction progress and debug info", false)
    .action(async (files: string[], opts: ExtractCommandOptions) => {
      const selectedFormat = opts.json ? "json" : opts.format;
      const format = selectedFormat === "json" ? "json" : selectedFormat === "markdown" ? "markdown" : null;
      if (!format) {
        throw new Error("--format must be one of: json, markdown");
      }

      const result = await runExtractCommand(files, {
        ...opts,
        format,
      });

      process.exitCode = result.exitCode;
    });

  program
    .command("store")
    .description("Store extracted knowledge entries in the local database")
    .argument("[files...]", "One or more extraction JSON files")
    .option("--db <path>", "Database path override")
    .option("--dry-run", "Show what would be stored without writing", false)
    .option("--verbose", "Show per-entry dedup decisions", false)
    .option("--force", "Skip dedup and store all entries as new", false)
    .option("--platform <name>", "Platform tag: openclaw, claude-code, codex")
    .option("--project <name>", "Project tag (lowercase).", (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option("--online-dedup", "Enable online LLM dedup at write time", true)
    .option("--no-online-dedup", "Disable online LLM dedup at write time")
    .option("--dedup-threshold <n>", "Similarity threshold for online dedup (0.0-1.0)")
    .action(
      async (
        files: string[],
        opts: {
          db?: string;
          dryRun?: boolean;
          verbose?: boolean;
          force?: boolean;
          platform?: string;
          project?: string | string[];
          onlineDedup?: boolean;
          dedupThreshold?: string;
        },
      ) => {
      const result = await runStoreCommand(files ?? [], opts);
      process.exitCode = result.exitCode;
      },
    );

  program
    .command("recall")
    .description("Recall knowledge from the local database")
    .argument("[query]", "Natural language query")
    .option("--limit <n>", "Maximum number of results", parseIntOption, 10)
    .option("--type <types>", "Filter by comma-separated entry types")
    .option("--tags <tags>", "Filter by comma-separated tags")
    .option("--min-importance <n>", "Minimum importance: 1-10")
    .option("--since <duration>", "Filter by recency (1h, 7d, 30d, 1y) or ISO timestamp")
    .option("--expiry <level>", "Filter by expiry: core|permanent|temporary")
    .option("--platform <name>", "Filter by platform: openclaw, claude-code, codex")
    .option("--project <name>", "Filter by project (repeatable)", (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option("--exclude-project <name>", "Exclude entries from project (repeatable)", (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option("--strict", "Exclude NULL-project entries from results", false)
    .option("--json", "Output JSON", false)
    .option("--db <path>", "Database path override")
    .option("--budget <tokens>", "Approximate token budget", parseIntOption)
    .option("--context <mode>", "Context mode: default|session-start|topic:<query>", "default")
    .option("--scope <level>", "Visibility scope: private|personal|public", "private")
    .option("--no-boost", "Disable scoring boosts and use raw vector similarity", false)
    .option("--no-update", "Do not increment recall metadata", false)
    .action(async (query: string | undefined, opts: Record<string, unknown>) => {
      const result = await runRecallCommand(query, {
        limit: opts.limit as number | undefined,
        type: opts.type as string | undefined,
        tags: opts.tags as string | undefined,
        minImportance: opts.minImportance as string | undefined,
        since: opts.since as string | undefined,
        expiry: opts.expiry as string | undefined,
        platform: opts.platform as string | undefined,
        project: opts.project as string | string[] | undefined,
        excludeProject: opts.excludeProject as string | string[] | undefined,
        strict: opts.strict === true,
        json: opts.json === true,
        db: opts.db as string | undefined,
        budget: opts.budget as number | undefined,
        context: opts.context as string | undefined,
        scope: opts.scope as string | undefined,
        noBoost: opts.noBoost === true,
        noUpdate: opts.noUpdate === true,
      });
      process.exitCode = result.exitCode;
    });

  program
    .command("retire <subject>")
    .description("Retire a stale entry from active recall (entry is hidden, not deleted)")
    .option("--persist", "Write to retirements ledger so retirement survives re-ingest")
    .option("--contains", "Use substring matching instead of exact match")
    .option("--dry-run", "Preview matches without retiring")
    .option("--reason <text>", "Reason for retirement")
    .option("--db <path>", "Path to database file")
    .action(async (subject: string, opts: Record<string, unknown>) => {
      const result = await runRetireCommand(subject, {
        persist: opts.persist === true,
        contains: opts.contains === true,
        dryRun: opts.dryRun === true,
        reason: opts.reason as string | undefined,
        db: opts.db as string | undefined,
      });
      process.exitCode = result.exitCode;
    });

  const evalCommand = program.command("eval").description("Evaluate recall scoring (read-only; no model calls)");

  evalCommand
    .command("recall")
    .description("Run a fixed query set against the local scoring algorithm and optionally diff against a baseline")
    .option("--save-baseline", "Save current results to ~/.agenr/eval-baseline.json", false)
    .option("--compare", "Compare current results against saved baseline", false)
    .option("--queries <path>", "Path to custom query set JSON", "~/.agenr/eval-queries.json")
    .option("--limit <n>", "Results per query to show", parseIntOption, 10)
    .option("--budget <n>", "Token budget passed to session-start recall", parseIntOption, 2000)
    .action(async (opts: Record<string, unknown>) => {
      const result = await runEvalRecallCommand({
        saveBaseline: opts.saveBaseline === true,
        compare: opts.compare === true,
        queries: opts.queries as string | undefined,
        limit: opts.limit as number | undefined,
        budget: opts.budget as number | undefined,
      });
      process.exitCode = result.exitCode;
    });

  program
    .command("context")
    .description(
      "Generate a context file for AI tool integration (session-start recall runs locally; no embedding API calls).",
    )
    .option("--output <path>", "Output file path", "~/.agenr/CONTEXT.md")
    .option("--budget <tokens>", "Approximate token budget", parseIntOption, 2000)
    .option("--limit <n>", "Max entries per category", parseIntOption, 10)
    .option("--db <path>", "Database path override")
    .option("--platform <name>", "Filter by platform: openclaw, claude-code, codex")
    .option("--project <name>", "Filter by project (repeatable)", (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option("--exclude-project <name>", "Exclude entries from project (repeatable)", (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option("--strict", "Exclude NULL-project entries from results", false)
    .option("--json", "Output JSON", false)
    .option("--quiet", "Suppress stderr output", false)
    .action(
      async (opts: {
        output?: string;
        budget?: number;
        limit?: number;
        db?: string;
        platform?: string;
        project?: string | string[];
        excludeProject?: string | string[];
        strict?: boolean;
        json?: boolean;
        quiet?: boolean;
      }) => {
      const result = await runContextCommand({
        output: opts.output,
        budget: opts.budget,
        limit: opts.limit,
        platform: opts.platform,
        project: opts.project,
        excludeProject: opts.excludeProject,
        strict: opts.strict === true,
        db: opts.db,
        json: opts.json === true,
        quiet: opts.quiet === true,
      });
      process.exitCode = result.exitCode;
      },
    );

  program
    .command("watch")
    .description("Watch a transcript file and auto-extract knowledge as it grows")
    .argument("[file]", "Transcript file to watch (.jsonl, .md, .txt)")
    .option("--dir <path>", "Sessions directory to watch (resolver picks active file)")
    .option("--platform <name>", "Session platform: openclaw, claude-code, codex, mtime")
    .option("--auto", "Deprecated: use --platform <name> instead", false)
    .option("--interval <seconds>", "Polling interval in seconds", parseIntOption, 300)
    .option("--min-chunk <chars>", "Minimum new chars before extraction", parseIntOption, 2000)
    .option("--context <path>", "Regenerate context file after each cycle")
    .option("--db <path>", "Database path override")
    .option("--model <model>", "LLM model to use")
    .option("--provider <name>", "LLM provider: anthropic, openai, openai-codex")
    .option("--raw", "Bypass adapter filtering (pass transcripts through unmodified)", false)
    .option("--verbose", "Show extraction progress", false)
    .option("--dry-run", "Extract without storing", false)
    .option("--once", "Run one cycle and exit", false)
    .option("--json", "Output JSON results", false)
    .action(async (file: string | undefined, opts: WatchCommandOptions) => {
      const result = await runWatchCommand(file, opts);
      process.exitCode = result.exitCode;
    });

  program
    .command("todo <subcommand> <subject>")
    .description("Manage todos in the knowledge base")
    .option("--db <path>", "Database path override")
    .action(async (subcommand: string, subject: string, opts: { db?: string }) => {
      const result = await runTodoCommand(subcommand, subject, { db: opts.db });
      process.exitCode = result.exitCode;
    });

  program
    .command("ingest")
    .description("Bulk-ingest knowledge from files and directories")
    .argument("<paths...>", "Files or directories to process")
    .option("--glob <pattern>", "File filter glob", "**/*.{jsonl,md,txt}")
    .option("--db <path>", "Database path override")
    .option("--model <model>", "LLM model to use")
    .option("--provider <name>", "LLM provider: anthropic, openai, openai-codex")
    .option("--platform <name>", "Platform tag: openclaw, claude-code, codex")
    .option("--project <name>", "Project tag (lowercase).", (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option("--verbose", "Show per-file details", false)
    .option("--raw", "Bypass adapter filtering (pass transcripts through unmodified)", false)
    .option("--dry-run", "Extract without storing", false)
    .option("--json", "Output JSON results", false)
    .option("--concurrency <n>", "Parallel chunk extractions", parseIntOption, 5)
    .option("--skip-ingested", "Skip already-ingested files", true)
    .option("--no-retry", "Disable auto-retry for failed files")
    .option("--max-retries <n>", "Maximum auto-retry attempts", parseIntOption, 3)
    .option("--force", "Clean re-ingest: delete previous rows for each file before processing", false)
    .action(async (paths: string[], opts: IngestCommandOptions) => {
      const result = await runIngestCommand(paths, opts);
      process.exitCode = result.exitCode;
    });

  program
    .command("consolidate")
    .description("Consolidate and clean up the knowledge database")
    .option("--rules-only", "Only run rule-based cleanup (no LLM)", false)
    .option("--dry-run", "Show what would happen without making changes", false)
    .option("--forget", "Delete forgetting candidates after consolidation", false)
    .option("--report", "Print pre-run stats report (with --dry-run: report only)", false)
    .option("--platform <name>", "Scope consolidation to platform: openclaw, claude-code, codex")
    .option("--project <name>", "Scope consolidation to project (repeatable)", (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option("--exclude-project <name>", "Exclude entries from project (repeatable)", (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option("--min-cluster <n>", "Minimum cluster size for merge (default: 2)", (value: string) =>
      Number.parseInt(value, 10),
    )
    .option("--sim-threshold <n>", "Phase 1 similarity threshold (default: 0.82; Phase 2 is max(value, 0.88))", (value: string) =>
      Number.parseFloat(value),
    )
    .option("--max-cluster-size <n>", "Maximum cluster size for LLM phases (default: 8 in Phase 1, 6 in Phase 2)", (value: string) =>
      Number.parseInt(value, 10),
    )
    .option("--type <type>", "Only consolidate entries of this type")
    .option("--show-flagged", "Show flagged merges awaiting review", false)
    .option("--idempotency-days <n>", "Skip recently consolidated merged entries for N days (default: 7)", (value: string) =>
      Number.parseInt(value, 10),
    )
    .option("--batch <n>", "Process N clusters this run, then stop and save checkpoint", (value: string) =>
      Number.parseInt(value, 10),
    )
    .option("--no-resume", "Ignore checkpoint and start a fresh consolidation run")
    .option("--verbose", "Show per-entry decisions", false)
    .option("--json", "Output report as JSON", false)
    .option("--db <path>", "Database path override")
    .action(async (opts: ConsolidateCommandOptions) => {
      const result = await runConsolidateCommand(opts);
      process.exitCode = result.exitCode;
    });

  program
    .command("health")
    .description("Show database health and forgetting candidates")
    .option("--db <path>", "Database path override")
    .action(async (opts: { db?: string }) => {
      const result = await runHealthCommand(opts);
      process.exitCode = result.exitCode;
    });

  program
    .command("mcp")
    .description("Start MCP server for cross-tool AI memory")
    .option("--db <path>", "Database path override")
    .option("--verbose", "Log requests to stderr", false)
    .action(async (opts: { db?: string; verbose?: boolean }) => {
      await runMcpCommand(opts);
    });

  const daemonCommand = program.command("daemon").description("Manage the agenr watch daemon");

  daemonCommand
    .command("install")
    .description("Install and start the watch daemon (macOS launchd)")
    .option("--force", "Overwrite existing launchd plist", false)
    .option("--interval <seconds>", "Watch interval for daemon mode", parseIntOption, 120)
    .option("--dir <path>", "Sessions directory to watch (overrides auto-detection)")
    .option("--platform <name>", "Platform name (openclaw, codex, claude-code)")
    .option("--node-path <path>", "Node binary path override for launchd")
    .option("--context <path>", "Regenerate context file after each cycle")
    .action(async (opts: DaemonInstallOptions) => {
      const result = await runDaemonInstallCommand(opts);
      process.exitCode = result.exitCode;
    });

  daemonCommand
    .command("start")
    .description("Start the watch daemon if installed")
    .action(async () => {
      const result = await runDaemonStartCommand({});
      process.exitCode = result.exitCode;
    });

  daemonCommand
    .command("stop")
    .description("Stop the watch daemon without uninstalling")
    .action(async () => {
      const result = await runDaemonStopCommand({});
      process.exitCode = result.exitCode;
    });

  daemonCommand
    .command("restart")
    .description("Restart the watch daemon")
    .action(async () => {
      const result = await runDaemonRestartCommand({});
      process.exitCode = result.exitCode;
    });

  daemonCommand
    .command("uninstall")
    .description("Stop and remove the watch daemon")
    .option("--yes", "Skip confirmation prompt", false)
    .action(async (opts: DaemonUninstallOptions) => {
      const result = await runDaemonUninstallCommand(opts);
      process.exitCode = result.exitCode;
    });

  daemonCommand
    .command("status")
    .description("Show daemon status and recent logs")
    .option("--lines <n>", "Number of log lines to include", parseIntOption, 20)
    .action(async (opts: DaemonStatusOptions) => {
      const result = await runDaemonStatusCommand(opts);
      process.exitCode = result.exitCode;
    });

  daemonCommand
    .command("logs")
    .description("Show or follow daemon logs")
    .option("--lines <n>", "Number of log lines", parseIntOption, 100)
    .option("--follow", "Follow logs continuously", false)
    .action(async (opts: DaemonLogsOptions) => {
      const result = await runDaemonLogsCommand(opts);
      process.exitCode = result.exitCode;
    });

  const dbCommand = program.command("db").description("Manage the local knowledge database");

  dbCommand
    .command("stats")
    .description("Show database statistics")
    .option("--db <path>", "Database path override")
    .option("--platform <name>", "Filter stats by platform")
    .option("--project <name>", "Filter by project (repeatable)", (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option("--exclude-project <name>", "Exclude entries from project (repeatable)", (val: string, prev: string[]) => [...prev, val], [] as string[])
    .action(async (opts: { db?: string; platform?: string; project?: string | string[]; excludeProject?: string | string[] }) => {
      await runDbStatsCommand({ db: opts.db, platform: opts.platform, project: opts.project, excludeProject: opts.excludeProject });
      process.exitCode = 0;
    });

  dbCommand
    .command("version")
    .description("Show database schema version information")
    .option("--db <path>", "Database path override")
    .action(async (opts: { db?: string }) => {
      await runDbVersionCommand({ db: opts.db });
      process.exitCode = 0;
    });

  dbCommand
    .command("export")
    .description("Export all non-superseded entries")
    .option("--json", "Export JSON", false)
    .option("--md", "Export markdown", false)
    .option("--db <path>", "Database path override")
    .option("--platform <name>", "Filter by platform: openclaw, claude-code, codex")
    .option("--project <name>", "Filter by project (repeatable)", (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option("--exclude-project <name>", "Exclude entries from project (repeatable)", (val: string, prev: string[]) => [...prev, val], [] as string[])
    .action(async (opts: { db?: string; json?: boolean; md?: boolean; platform?: string; project?: string | string[]; excludeProject?: string | string[] }) => {
      await runDbExportCommand({
        db: opts.db,
        json: opts.json,
        md: opts.md,
        platform: opts.platform,
        project: opts.project,
        excludeProject: opts.excludeProject,
      });
      process.exitCode = 0;
    });

  dbCommand
    .command("reset")
    .description("Drop all database objects and recreate schema")
    .option("--confirm", "Required confirmation flag", false)
    .option("--db <path>", "Database path override")
    .action(async (opts: { db?: string; confirm?: boolean }) => {
      await runDbResetCommand({ db: opts.db, confirm: opts.confirm });
      process.exitCode = 0;
    });

  dbCommand
    .command("path")
    .description("Print the resolved database path")
    .option("--db <path>", "Database path override")
    .action(async (opts: { db?: string }) => {
      await runDbPathCommand({ db: opts.db });
      process.exitCode = 0;
    });

  dbCommand
    .command("check")
    .description("Run database integrity checks (including vector index)")
    .option("--db <path>", "Database path override")
    .action(async (opts: { db?: string }) => {
      const result = await runDbCheckCommand({ db: opts.db });
      process.exitCode = result.exitCode;
    });

  dbCommand
    .command("rebuild-index")
    .description("Drop and recreate the vector index (run after forced kills like SIGKILL/power loss)")
    .option("--db <path>", "Database path override")
    .action(async (opts: { db?: string }) => {
      const result = await runDbRebuildIndexCommand({ db: opts.db });
      process.exitCode = result.exitCode;
    });

  program
    .command("setup")
    .description("Interactive setup for provider/auth/model defaults")
    .action(async () => {
      await runSetup(process.env);
    });

  const configCommand = program.command("config").description("Show and update agenr configuration");

  configCommand
    .command("set")
    .description("Set one config value: provider, model, or auth")
    .argument("<key>", "Config key: provider, model, auth")
    .argument("<value>", "Config value")
    .action((key: string, value: string) => {
      if (key !== "provider" && key !== "model" && key !== "auth") {
        throw new Error('Invalid key. Expected one of: "provider", "model", "auth".');
      }

      const current = readConfig(process.env);
      const result = setConfigKey(current, key, value);
      writeConfig(result.config, process.env);
      clack.log.success(formatLabel(`Updated ${key}`, value));
      for (const warning of result.warnings) {
        clack.log.warn(warning);
      }
    });

  configCommand
    .command("set-key")
    .description("Store a credential: anthropic, anthropic-token, openai")
    .argument("<provider>", "Credential key: anthropic, anthropic-token, openai")
    .argument("<key>", "Secret value")
    .action((provider: string, key: string) => {
      if (provider !== "anthropic" && provider !== "anthropic-token" && provider !== "openai") {
        throw new Error('Invalid key name. Expected one of: "anthropic", "anthropic-token", "openai".');
      }

      const current = readConfig(process.env);
      const next = setStoredCredential(current, provider, key);
      writeConfig(next, process.env);
      clack.log.success(formatLabel(`Updated ${provider}`, "stored"));
      clack.log.info("Verify with " + ui.bold("agenr auth status"));
    });

  configCommand
    .command("show")
    .description("Show current config and credential availability")
    .action(() => {
      clack.intro(banner());

      const config = readConfig(process.env);
      if (!config) {
        clack.log.warn("Not configured.");
        clack.outro("Run " + ui.bold("agenr setup"));
        return;
      }

      let source = "not found";
      let available = false;
      if (config.auth) {
        const probe = probeCredentials({
          auth: config.auth,
          storedCredentials: config.credentials,
          env: process.env,
        });
        source = probe.source ?? "not found";
        available = probe.available;
      }

      clack.note(
        [
          formatLabel("Auth", config.auth ? describeAuth(config.auth) : ui.dim("(not set)")),
          formatLabel("Provider", config.provider ?? ui.dim("(not set)")),
          formatLabel("Model", config.model ?? ui.dim("(not set)")),
          "",
          ui.bold("Credentials"),
          formatLabel("  Anthropic API Key", maskSecret(config.credentials?.anthropicApiKey)),
          formatLabel("  Anthropic Token", maskSecret(config.credentials?.anthropicOauthToken)),
          formatLabel("  OpenAI API Key", maskSecret(config.credentials?.openaiApiKey)),
          "",
          formatLabel("Source", source),
          formatLabel("Available", available ? formatSuccess("yes") : formatError("no")),
        ].join("\n"),
        "Configuration",
      );

      clack.outro();
    });

  const authCommand = program.command("auth").description("Authentication status and diagnostics");

  authCommand
    .command("status")
    .description("Run a live auth check against the configured model")
    .action(async () => {
      clack.intro(banner());

      const quick = getQuickStatus(process.env);
      if (!quick.configured) {
        clack.log.warn("Not configured");
        clack.outro("Run " + ui.bold("agenr setup") + " to get started.");
        return;
      }

      const spinner = clack.spinner();
      spinner.start("Checking credentials...");

      const status = await getAuthStatus(process.env);

      if (status.authenticated) {
        spinner.stop(ui.success("Authenticated"));
      } else if (!status.credentialAvailable) {
        spinner.stop(ui.warn("No credentials found"));
      } else {
        spinner.stop(ui.error("Authentication failed"));
      }

      clack.note(
        [
          formatLabel("Provider", status.provider ?? "(not set)"),
          formatLabel("Auth", status.auth ? formatAuthSummary(status.auth) : "(not set)"),
          formatLabel("Model", status.model ?? "(not set)"),
          formatLabel("Credential", status.credentialSource ?? "not found"),
          "",
          status.authenticated ? ui.success("Ready to extract") : ui.error(status.error ?? status.guidance),
        ].join("\n"),
        "Auth Status",
      );

      if (!status.authenticated && status.guidance) {
        clack.log.info(status.guidance);
      }

      clack.outro();
    });

  return program;
}
