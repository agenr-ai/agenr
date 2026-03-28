import { ingestDiscoveredFiles } from "../../../app/ingestion/index.js";
import { createDatabase } from "../../../adapters/db/client.js";
import { createEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../../adapters/embeddings.js";
import { localTranscriptFiles } from "../../../adapters/files/transcript-files.js";
import { createLlmClient, resolveLlmApiKey, resolveModel } from "../../../adapters/llm.js";
import { openClawTranscriptParser } from "../../../adapters/openclaw/transcript/parser.js";
import { configFileExists, readConfig, resolveConfigPath, resolveDbPath, type AgenrAuthMethod, type AgenrConfig } from "../../../config.js";
import { pluralize } from "../ingest.js";
import { formatExistingConfig, getSetupReadiness, isSetupConfigured, runSetupCore, type SetupCoreResult, type SetupProvider } from "../setup.js";
import { banner, cliPrompts, formatLabel, formatPathForDisplay, ui, type WizardPrompts } from "../../ui.js";
import { estimateIngestCost, formatCostUsd, formatTokenCount, type CostEstimate } from "./cost-estimator.js";
import { installOpenClawPlugin, restartOpenClawGateway, writeOpenClawPluginConfig } from "./external-commands.js";
import { detectOpenClawInstallation, type OpenClawDetection } from "./openclaw-detect.js";
import { scanSessionFiles, type SessionScanResult } from "./session-scanner.js";

/** Summary emitted by init's optional bulk-ingest step. */
export interface BulkIngestResult {
  /** Number of transcript files processed. */
  filesProcessed: number;
  /** Number of entries stored into the knowledge database. */
  storedEntries: number;
  /** Number of files that failed extraction or parsing. */
  failedFiles: number;
  /** Combined extraction and dedup model cost in USD. */
  totalCostUsd: number;
}

/** Runtime hooks used by the init wizard for testability. */
export interface InitWizardRuntime {
  /** Reusable setup flow shared with `agenr setup`. */
  runSetupCore: typeof runSetupCore;
  /** OpenClaw detection logic. */
  detectOpenClawInstallation: typeof detectOpenClawInstallation;
  /** Plugin install helper. */
  installOpenClawPlugin: typeof installOpenClawPlugin;
  /** Gateway restart helper. */
  restartOpenClawGateway: typeof restartOpenClawGateway;
  /** OpenClaw config writer. */
  writeOpenClawPluginConfig: typeof writeOpenClawPluginConfig;
  /** Session scan helper. */
  scanSessionFiles: typeof scanSessionFiles;
  /** Ingest cost estimator. */
  estimateIngestCost: typeof estimateIngestCost;
  /** Optional bulk-ingest executor used by init. */
  runBulkIngest(files: string[], config: AgenrConfig, prompts: WizardPrompts): Promise<BulkIngestResult>;
}

/** Options accepted by the interactive init wizard. */
export interface InitWizardOptions {
  /** Prompt implementation used by the wizard. */
  prompts?: WizardPrompts;
  /** Runtime hooks used by the wizard. */
  runtime?: InitWizardRuntime;
}

const defaultInitRuntime: InitWizardRuntime = {
  runSetupCore,
  detectOpenClawInstallation,
  installOpenClawPlugin,
  restartOpenClawGateway,
  writeOpenClawPluginConfig,
  scanSessionFiles,
  estimateIngestCost,
  runBulkIngest,
};

/**
 * Runs the full first-run onboarding wizard.
 *
 * @param options - Prompt and runtime overrides used primarily by tests.
 */
export async function runInitWizard(options: InitWizardOptions = {}): Promise<void> {
  const prompts = options.prompts ?? cliPrompts;
  const runtime = options.runtime ?? defaultInitRuntime;

  prompts.intro(banner());

  try {
    const existingConfig = readConfig();
    const hasExistingConfig = configFileExists();
    const configPath = resolveConfigPath();
    let activeConfig = hasExistingConfig ? existingConfig : undefined;
    let setupResult: SetupCoreResult | null = null;

    if (hasExistingConfig && activeConfig) {
      prompts.note(formatExistingConfig(activeConfig, configPath, resolveDbPath(activeConfig)), "Current config");
    }

    if (!isSetupConfigured(activeConfig)) {
      if (hasExistingConfig) {
        prompts.log.warn("The existing agenr config is incomplete. Running setup before continuing.");
      }

      setupResult = await runtime.runSetupCore({
        existingConfig: activeConfig,
        prompts,
      });
      if (!setupResult) {
        prompts.cancel("Init cancelled.");
        return;
      }

      activeConfig = setupResult.config;
    } else if (hasExistingConfig) {
      const reconfigure = await prompts.confirm({
        message: "Reconfigure provider, keys, or model before continuing?",
        initialValue: false,
      });

      if (prompts.isCancel(reconfigure)) {
        prompts.cancel("Init cancelled.");
        return;
      }

      if (reconfigure) {
        setupResult = await runtime.runSetupCore({
          existingConfig: activeConfig,
          prompts,
        });
        if (!setupResult) {
          prompts.cancel("Init cancelled.");
          return;
        }

        activeConfig = setupResult.config;
      }
    } else {
      setupResult = await runtime.runSetupCore({
        prompts,
      });
      if (!setupResult) {
        prompts.cancel("Init cancelled.");
        return;
      }

      activeConfig = setupResult.config;
    }

    if (!activeConfig) {
      throw new Error("Setup completed without a config.");
    }

    const setupReadiness = setupResult
      ? {
          ready: setupResult.ready,
          guidance: setupResult.readinessGuidance,
        }
      : getSetupReadiness(activeConfig);
    const setupReady = setupReadiness.ready;
    if (!setupReady) {
      prompts.log.warn(
        setupReadiness.guidance ?? "The selected auth profile is saved, but agenr still needs working credentials before recall or ingest can run.",
      );
    }

    const detection = runtime.detectOpenClawInstallation();
    const dbPath = resolveDbPath(activeConfig);
    let pluginStatus = "OpenClaw not detected";
    let gatewayStatus = "Not needed";
    let sessionStatus = "Skipped";
    let ingestStatus = "Skipped";
    let sessionScan: SessionScanResult | null = null;

    if (detection.detected) {
      prompts.log.info(
        [
          formatLabel("OpenClaw", "detected"),
          formatLabel("State", formatPathForDisplay(detection.stateDir)),
          formatLabel("Sessions", formatPathForDisplay(detection.sessionsRoot)),
        ].join("\n"),
      );

      const installPlugin = await prompts.confirm({
        message: "Install and configure the agenr OpenClaw plugin now?",
        initialValue: true,
      });

      if (prompts.isCancel(installPlugin)) {
        prompts.cancel("Init cancelled.");
        return;
      }

      if (installPlugin) {
        const installSpinner = prompts.spinner();
        installSpinner.start("Installing agenr plugin for OpenClaw...");
        const installResult = await runtime.installOpenClawPlugin();
        installSpinner.stop(installResult.message);
        pluginStatus = installResult.message;

        if (installResult.success) {
          try {
            const openclawConfigPath = await runtime.writeOpenClawPluginConfig(detection.stateDir, {
              dbPath,
              configPath,
            });
            prompts.log.info(`Updated ${formatPathForDisplay(openclawConfigPath)} to enable agenr as the active memory plugin.`);
          } catch (error) {
            const message = formatUnknownError(error);
            pluginStatus = `Plugin installed, but OpenClaw config update failed: ${message}`;
            prompts.log.warn(`OpenClaw config update failed: ${message}`);
          }

          const restartSpinner = prompts.spinner();
          restartSpinner.start("Restarting OpenClaw gateway...");
          const restartResult = await runtime.restartOpenClawGateway();
          restartSpinner.stop(restartResult.message);
          gatewayStatus = restartResult.message;
        }
      } else {
        pluginStatus = "Skipped - plugin not installed";
      }

      const scanSpinner = prompts.spinner();
      scanSpinner.start("Scanning existing OpenClaw sessions...");
      sessionScan = await runtime.scanSessionFiles(detection.sessionsRoot);
      scanSpinner.stop(
        `Found ${sessionScan.totalFiles} ${pluralize(sessionScan.totalFiles, "session")} under ${formatPathForDisplay(detection.sessionsRoot)}.`,
      );

      if (sessionScan.totalFiles === 0) {
        sessionStatus = "No sessions found";
        ingestStatus = "Skipped - no sessions found";
        prompts.log.info("No existing OpenClaw session transcripts were found. You can ingest later once sessions exist.");
      } else if (!setupReady) {
        sessionStatus = `${sessionScan.totalFiles} ${pluralize(sessionScan.totalFiles, "session")} found (${sessionScan.recentFiles.length} from last 7 days)`;
        ingestStatus = "Skipped - current auth still needs credentials";
        prompts.log.warn(setupReadiness.guidance ?? "Skipping bulk ingest until agenr can resolve working LLM credentials for the selected auth profile.");
      } else {
        sessionStatus = `${sessionScan.totalFiles} ${pluralize(sessionScan.totalFiles, "session")} found (${sessionScan.recentFiles.length} from last 7 days)`;
        const { provider: extractionProvider, modelId } = resolveModel(activeConfig, "extraction");
        const providerForCost = normalizeSetupProvider(extractionProvider);
        const showUsdEstimate = hasMeteredIngestCost(activeConfig.auth);
        const recentCost = runtime.estimateIngestCost(sessionScan.recentSizeBytes, modelId, providerForCost);
        const fullCost = runtime.estimateIngestCost(sessionScan.totalSizeBytes, modelId, providerForCost);

        const ingestChoice = await prompts.select<"recent" | "all" | "skip">({
          message: buildIngestChoiceMessage(sessionScan, modelId, recentCost, fullCost, showUsdEstimate),
          options: buildIngestOptions(sessionScan, recentCost, fullCost, showUsdEstimate),
          initialValue: sessionScan.recentFiles.length > 0 ? "recent" : "all",
        });

        if (prompts.isCancel(ingestChoice)) {
          prompts.cancel("Init cancelled.");
          return;
        }

        if (ingestChoice === "skip") {
          ingestStatus = "Skipped";
        } else {
          const filesToIngest = ingestChoice === "recent" ? sessionScan.recentFiles : sessionScan.allFiles;
          const ingestResult = await runtime.runBulkIngest(filesToIngest, activeConfig, prompts);
          ingestStatus =
            `${ingestResult.filesProcessed} ${pluralize(ingestResult.filesProcessed, "session")} processed, ` +
            `${ingestResult.storedEntries} ${pluralize(ingestResult.storedEntries, "entry", "entries")} stored`;

          prompts.log.info(
            [
              formatLabel("Ingested", `${ingestResult.filesProcessed} ${pluralize(ingestResult.filesProcessed, "session")}`),
              formatLabel("Stored", `${ingestResult.storedEntries} ${pluralize(ingestResult.storedEntries, "entry", "entries")}`),
              formatLabel("Failures", `${ingestResult.failedFiles}`),
              formatLabel("Cost", formatCostUsd(ingestResult.totalCostUsd)),
            ].join("\n"),
          );

          if (ingestResult.failedFiles > 0) {
            prompts.log.warn(`Bulk ingest completed with ${ingestResult.failedFiles} file failures.`);
          }
        }
      }
    } else {
      prompts.log.info("OpenClaw was not detected. You can install the plugin later after OpenClaw is set up.");
    }

    prompts.note(
      buildInitSummary({
        configPath,
        dbPath,
        config: activeConfig,
        detection,
        pluginStatus,
        gatewayStatus,
        sessionStatus,
        ingestStatus,
      }),
      "Init summary",
    );

    prompts.outro(buildNextSteps(detection, pluginStatus, gatewayStatus, sessionScan));
  } catch (error) {
    process.exitCode = 1;
    prompts.log.error(formatUnknownError(error));
    prompts.outro(ui.error("Init failed"));
  }
}

/** Runs the init-time bulk-ingest path without shelling out to `agenr ingest`. */
async function runBulkIngest(files: string[], config: AgenrConfig, prompts: WizardPrompts): Promise<BulkIngestResult> {
  let database: Awaited<ReturnType<typeof createDatabase>> | null = null;
  const spinner = prompts.spinner();
  spinner.start(`Ingesting ${files.length} ${pluralize(files.length, "session")}... (0/${files.length} extracted)`);

  try {
    database = await createDatabase(resolveDbPath(config));

    const { provider, modelId } = resolveModel(config, "extraction");
    const { provider: dedupProvider, modelId: dedupModelId } = resolveModel(config, "dedup");
    const extractionApiKey = resolveLlmApiKey(config, provider);
    const dedupApiKey = resolveLlmApiKey(config, dedupProvider);
    const embeddingClient = createEmbeddingClient(resolveEmbeddingApiKey(config), resolveEmbeddingModel(config));

    const result = await ingestDiscoveredFiles(
      files,
      {
        files: localTranscriptFiles,
        transcript: openClawTranscriptParser,
        db: database,
        embedding: embeddingClient,
        createExtractionLlm: () => createLlmClient(provider, modelId, { apiKey: extractionApiKey }),
        createDedupLlm: () => createLlmClient(dedupProvider, dedupModelId, { apiKey: dedupApiKey }),
      },
      {
        extractionContext: config.extractionContext,
        onExtractionProgress: (completed, total) => {
          spinner.message(`Ingesting sessions... (${completed}/${total} extracted)`);
        },
        onBulkWriteProgress: (event) => {
          spinner.message(progressMessageForBulkWrite(event.phase));
        },
      },
    );

    const storedEntries = Array.from(result.storeResults.values()).reduce((total, fileResult) => total + (fileResult.storeResult?.stored ?? 0), 0);
    const failedFiles = result.extractionRuns.filter((run) => run.result.error !== undefined).length;
    const totalCostUsd = result.extractionRuns.reduce((total, run) => total + run.usage.totalCost, 0) + result.dedupUsage.totalCost;

    spinner.stop(`Ingest complete: ${storedEntries} ${pluralize(storedEntries, "entry", "entries")} stored.`);
    return {
      filesProcessed: files.length,
      storedEntries,
      failedFiles,
      totalCostUsd,
    };
  } finally {
    await database?.close();
  }
}

/** Builds the cost-selection prompt body for init-time ingest. */
function buildIngestChoiceMessage(
  scan: SessionScanResult,
  modelId: string,
  recentCost: CostEstimate,
  fullCost: CostEstimate,
  showUsdEstimate: boolean,
): string {
  const lines = [
    `Found ${scan.totalFiles} ${pluralize(scan.totalFiles, "session")} (${scan.recentFiles.length} from last 7 days).`,
    "",
    showUsdEstimate ? `Estimated extraction cost with ${modelId}:` : `Estimated transcript volume with ${modelId}:`,
  ];

  if (scan.recentFiles.length > 0) {
    lines.push(
      showUsdEstimate
        ? `Last 7 days:  ${formatTokenCount(recentCost.inputTokens)} tokens  ${formatCostUsd(recentCost.totalCostUsd)}`
        : `Last 7 days:  ${formatTokenCount(recentCost.inputTokens)} tokens`,
    );
  }

  lines.push(
    showUsdEstimate
      ? `Full history: ${formatTokenCount(fullCost.inputTokens)} tokens  ${formatCostUsd(fullCost.totalCostUsd)}`
      : `Full history: ${formatTokenCount(fullCost.inputTokens)} tokens`,
  );

  if (!showUsdEstimate) {
    lines.push("");
    lines.push("Current auth is subscription-backed, so this wizard does not estimate per-token charges.");
  }

  return lines.join("\n");
}

/** Builds the init-time ingest choice list. */
function buildIngestOptions(
  scan: SessionScanResult,
  recentCost: CostEstimate,
  fullCost: CostEstimate,
  showUsdEstimate: boolean,
): Array<{ value: "recent" | "all" | "skip"; label: string; hint?: string }> {
  const options: Array<{ value: "recent" | "all" | "skip"; label: string; hint?: string }> = [];
  if (scan.recentFiles.length > 0) {
    options.push({
      value: "recent",
      label: showUsdEstimate
        ? `Ingest the last 7 days (${formatCostUsd(recentCost.totalCostUsd)})`
        : `Ingest the last 7 days (${formatTokenCount(recentCost.inputTokens)} tokens)`,
      hint: "recommended",
    });
  }

  options.push({
    value: "all",
    label: showUsdEstimate
      ? `Ingest all sessions (${formatCostUsd(fullCost.totalCostUsd)})`
      : `Ingest all sessions (${formatTokenCount(fullCost.inputTokens)} tokens)`,
    hint: "may take a while",
  });
  options.push({
    value: "skip",
    label: "Skip ingestion for now",
  });

  return options;
}

/** Formats the final init summary note. */
function buildInitSummary(options: {
  configPath: string;
  dbPath: string;
  config: AgenrConfig;
  detection: OpenClawDetection;
  pluginStatus: string;
  gatewayStatus: string;
  sessionStatus: string;
  ingestStatus: string;
}): string {
  const lines = [
    formatLabel("Config", formatPathForDisplay(options.configPath)),
    formatLabel("Provider", options.config.provider ?? "(not set)"),
    formatLabel("Model", options.config.model ?? "(not set)"),
    formatLabel("Database", formatPathForDisplay(options.dbPath)),
    formatLabel("OpenClaw", options.detection.detected ? formatPathForDisplay(options.detection.stateDir) : "not detected"),
    formatLabel("Plugin", options.pluginStatus),
    formatLabel("Gateway", options.gatewayStatus),
    formatLabel("Sessions", options.sessionStatus),
    formatLabel("Ingest", options.ingestStatus),
    formatLabel("Corpus health", "Not yet available in v1"),
  ];

  return lines.join("\n");
}

/** Builds the closing next-steps line for init. */
function buildNextSteps(detection: OpenClawDetection, pluginStatus: string, gatewayStatus: string, sessionScan: SessionScanResult | null): string {
  const steps = [`Try ${ui.bold('agenr recall "test"')}.`];

  if (!detection.detected) {
    steps.push("Install OpenClaw later, then rerun `agenr init` to enable the plugin.");
  } else {
    if (!pluginStatus.toLowerCase().includes("installed")) {
      steps.push("Install the plugin later with `openclaw plugins install agenr`.");
    }

    if (gatewayStatus.toLowerCase().includes("manual restart")) {
      steps.push("Run `openclaw gateway restart` after the plugin is installed.");
    }

    if (sessionScan && sessionScan.totalFiles > 0) {
      steps.push(`You can re-run bulk ingest later with ${ui.bold(`agenr ingest ${formatPathForDisplay(detection.sessionsRoot)}`)}.`);
    }
  }

  return steps.join(" ");
}

/** Maps resolved providers into the smaller set supported by the cost estimator. */
function normalizeSetupProvider(provider: string): SetupProvider {
  if (provider === "anthropic" || provider === "openai-codex") {
    return provider;
  }

  return "openai";
}

/** Returns whether init should show dollar-denominated ingest estimates. */
function hasMeteredIngestCost(auth: AgenrAuthMethod | undefined): boolean {
  return auth !== "openai-subscription" && auth !== "anthropic-oauth" && auth !== "anthropic-token";
}

/** Maps bulk-write progress phases into spinner text. */
function progressMessageForBulkWrite(phase: "prepare_start" | "store_complete" | "finalize_start" | "finalize_complete"): string {
  switch (phase) {
    case "prepare_start":
      return "Preparing database indexes for bulk ingest...";
    case "store_complete":
      return "Bulk ingest store phase complete...";
    case "finalize_start":
      return "Rebuilding indexes after bulk ingest...";
    case "finalize_complete":
      return "Bulk ingest finalization complete...";
  }
}

/** Formats unknown thrown values into readable error messages. */
function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
