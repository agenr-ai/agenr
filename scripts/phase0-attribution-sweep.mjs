#!/usr/bin/env node
/**
 * Phase 0 attribution sweep for recall-regression-resolution_7f2c19d3.plan.md.
 *
 * Runs each of the 23 regressed cases from `agenr-evals` through the internal
 * eval HTTP seam under up to five ranking-policy variants so the attribution
 * ledger at docs/internal/recall/regression-attribution.md can be filled in
 * with real verdicts instead of `pending` placeholders.
 *
 * Preconditions:
 *   1. Build agenr (`pnpm build`).
 *   2. Start the internal eval server with an OpenAI credential resolvable
 *      through agenr config. For local operators the sandbox config works:
 *        AGENR_CONFIG_PATH=$HOME/.openclaw-sandbox/agenr-data/config.json \
 *        node dist/internal-eval-server.js
 *   3. Run this script:
 *        node scripts/phase0-attribution-sweep.mjs
 *
 * The script fails loud when:
 *   - The server is not reachable at AGENR_SWEEP_BASE_URL
 *     (default http://127.0.0.1:4010).
 *   - A case JSON is missing or uses a comparator other than `partial`.
 *   - The server returns a non-ok recall response for a baseline variant.
 *
 * Output:
 *   - Per-run artifacts under artifacts/regression-attribution/<runId>/runs/
 *     as JSON files named `<row>-<variantId>.json`.
 *   - A combined ledger at artifacts/regression-attribution/<runId>/ledger.json
 *     that mirrors the Classification Summary columns.
 *   - A prerendered Markdown fragment at
 *     artifacts/regression-attribution/<runId>/classification.md
 *     that can be pasted into the attribution doc.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const EVALS_ROOT = process.env.AGENR_SWEEP_EVALS_ROOT ? resolve(process.env.AGENR_SWEEP_EVALS_ROOT) : resolve(REPO_ROOT, "..", "agenr-evals");
const BASE_URL = process.env.AGENR_SWEEP_BASE_URL ?? "http://127.0.0.1:4010";
const RECALL_PATH = "/internal/evals/recall/run";
const BEFORE_TURN_PATH = "/internal/evals/before-turn/run";
const OUTPUT_ROOT = resolve(REPO_ROOT, "artifacts", "regression-attribution");

/**
 * The 23 regressed case rows from the attribution doc. `row` matches the
 * `#` column. `caseFile` is a path relative to agenr-evals/. `manifest` is
 * the origin manifest used for the row's title. For cases shared across
 * manifests (memory-freshness lineage and the two before-turn variants),
 * the sweep executes the case once and broadcasts the verdict to every
 * row that shares the case file.
 */
const INVENTORY = [
  {
    row: 1,
    caseId: "agenr.recall.http.debug.preserved-sandbox",
    caseFile: "cases/agenr-recall-http-debug-preserved-sandbox.json",
    manifest: "agenr-recall-http",
    endpoint: "recall",
  },
  {
    row: 2,
    caseId: "agenr.recall.corpus.core.research-notes",
    caseFile: "cases/initial-recall-corpus/research-notes.json",
    manifest: "agenr-recall-http-initial-corpus",
    endpoint: "recall",
  },
  {
    row: 3,
    caseId: "agenr.recall.corpus.ranking.prompt-drafting-style",
    caseFile: "cases/initial-recall-corpus/prompt-drafting-style.json",
    manifest: "agenr-recall-http-initial-corpus",
    endpoint: "recall",
  },
  {
    row: 4,
    caseId: "agenr.recall.corpus.ranking.prompt-canonical-directory",
    caseFile: "cases/initial-recall-corpus/prompt-canonical-directory.json",
    manifest: "agenr-recall-http-initial-corpus",
    endpoint: "recall",
  },
  {
    row: 5,
    caseId: "agenr.recall.corpus.ranking.open-source-workflow",
    caseFile: "cases/initial-recall-corpus/open-source-workflow.json",
    manifest: "agenr-recall-http-initial-corpus",
    endpoint: "recall",
  },
  {
    row: 6,
    caseId: "agenr.recall.corpus.ranking.auth-choice",
    caseFile: "cases/initial-recall-corpus/auth-choice.json",
    manifest: "agenr-recall-http-initial-corpus",
    endpoint: "recall",
  },
  {
    row: 7,
    caseId: "agenr.recall.corpus.ranking.broad-memory-rollup",
    caseFile: "cases/initial-recall-corpus/broad-memory-rollup.json",
    manifest: "agenr-recall-http-initial-corpus",
    endpoint: "recall",
  },
  {
    row: 8,
    caseId: "agenr.recall.claim.section1.deployment-approach.previous-state",
    caseFile: "cases/claim-centric/deployment-approach.previous-state.json",
    manifest: "agenr-recall-http-claim-centric-section-1",
    endpoint: "recall",
  },
  {
    row: 9,
    caseId: "agenr.recall.claim.section1.deployment-approach.what-changed",
    caseFile: "cases/claim-centric/deployment-approach.what-changed.json",
    manifest: "agenr-recall-http-claim-centric-section-1",
    endpoint: "recall",
  },
  {
    row: 10,
    caseId: "agenr.recall.memory-freshness.section1.current-truth-beats-old-plan.current",
    caseFile: "cases/memory-freshness/current-truth-beats-old-plan.current.json",
    manifest: "agenr-recall-http-memory-freshness-section-1",
    endpoint: "recall",
  },
  {
    row: 11,
    caseId: "agenr.recall.memory-freshness.section1.current-truth-beats-old-plan.historical",
    caseFile: "cases/memory-freshness/current-truth-beats-old-plan.historical.json",
    manifest: "agenr-recall-http-memory-freshness-section-1",
    endpoint: "recall",
  },
  {
    row: 12,
    caseId: "agenr.recall.memory-freshness.section1.superseded-workflow.historical",
    caseFile: "cases/memory-freshness/superseded-workflow.historical.json",
    manifest: "agenr-recall-http-memory-freshness-section-1",
    endpoint: "recall",
  },
  {
    row: 13,
    caseId: "agenr.recall.memory-freshness.section1.recent-obsolete-plan-loses.current",
    caseFile: "cases/memory-freshness/recent-obsolete-plan-loses.current.json",
    manifest: "agenr-recall-http-memory-freshness-section-1",
    endpoint: "recall",
  },
  {
    row: 14,
    caseId: "agenr.recall.memory-freshness.section1.recent-obsolete-plan-loses.historical",
    caseFile: "cases/memory-freshness/recent-obsolete-plan-loses.historical.json",
    manifest: "agenr-recall-http-memory-freshness-section-1",
    endpoint: "recall",
  },
  {
    row: 15,
    caseId: "agenr.recall.memory-freshness.section1.old-plan-without-replacement.current",
    caseFile: "cases/memory-freshness/old-plan-without-replacement.current.json",
    manifest: "agenr-recall-http-memory-freshness-section-1",
    endpoint: "recall",
  },
  {
    row: 16,
    caseId: "agenr.recall.memory-freshness.section1.retired-guidance-loses.historical",
    caseFile: "cases/memory-freshness/retired-guidance-loses.historical.json",
    manifest: "agenr-recall-http-memory-freshness-section-1",
    endpoint: "recall",
  },
  {
    row: 17,
    caseId: "agenr.recall.memory-freshness.section1.current-truth-beats-old-plan.current",
    caseFile: "cases/memory-freshness/current-truth-beats-old-plan.current.json",
    manifest: "agenr-recall-http-memory-freshness-section-1-lineage-ranking",
    endpoint: "recall",
  },
  {
    row: 18,
    caseId: "agenr.recall.memory-freshness.section1.current-truth-beats-old-plan.historical",
    caseFile: "cases/memory-freshness/current-truth-beats-old-plan.historical.json",
    manifest: "agenr-recall-http-memory-freshness-section-1-lineage-ranking",
    endpoint: "recall",
  },
  {
    row: 19,
    caseId: "agenr.recall.memory-freshness.section1.superseded-workflow.historical",
    caseFile: "cases/memory-freshness/superseded-workflow.historical.json",
    manifest: "agenr-recall-http-memory-freshness-section-1-lineage-ranking",
    endpoint: "recall",
  },
  {
    row: 20,
    caseId: "agenr.recall.memory-freshness.section1.recent-obsolete-plan-loses.historical",
    caseFile: "cases/memory-freshness/recent-obsolete-plan-loses.historical.json",
    manifest: "agenr-recall-http-memory-freshness-section-1-lineage-ranking",
    endpoint: "recall",
  },
  {
    row: 21,
    caseId: "agenr.recall.temporal.section1.repository-owner.previous-state",
    caseFile: "cases/temporal-slot-policy/repository-owner.previous-state.json",
    manifest: "agenr-recall-http-temporal-slot-policy-section-1",
    endpoint: "recall",
  },
  {
    row: 22,
    caseId: "before-turn.contextual-follow-up.fallback.inject",
    caseFile: "cases/before-turn/contextual-follow-up-fallback.inject.json",
    manifest: "before-turn-section-4-contextual-follow-up",
    endpoint: "before-turn",
  },
  {
    row: 23,
    caseId: "before-turn.contextual-follow-up.fallback.inject",
    caseFile: "cases/before-turn/contextual-follow-up-fallback.inject.json",
    manifest: "before-turn-section-5-ablations",
    endpoint: "before-turn",
  },
];

/**
 * Five ranking-policy variants used for the recall sweep. The before-turn
 * seam does not accept rankingPolicy, so only the baseline variant runs
 * for before-turn rows.
 */
const RECALL_VARIANTS = [
  { id: "baseline", policy: undefined },
  { id: "rrf_disabled", policy: { rrf: "disabled" } },
  { id: "neighborhood_disabled", policy: { neighborhood: "disabled" } },
  { id: "mmr_disabled", policy: { mmr: "disabled" } },
  { id: "cross_encoder_disabled", policy: { crossEncoder: "disabled" } },
];

const BEFORE_TURN_VARIANTS = [{ id: "baseline", policy: undefined }];

/**
 * Minimal port of agenr-evals comparePartial for our "partial" comparator.
 */
function comparePartial(actual, expected, allowExtraFields, path, messages) {
  if (expected === undefined) {
    return;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      messages.push(`${path} expected array but received ${typeof actual}`);
      return;
    }

    if ((!allowExtraFields && actual.length !== expected.length) || actual.length < expected.length) {
      messages.push(`${path} expected ${allowExtraFields ? "at least " : ""}${expected.length} array entries`);
    }

    expected.forEach((expectedItem, index) => {
      comparePartial(actual[index], expectedItem, allowExtraFields, `${path}[${index}]`, messages);
    });
    return;
  }

  if (isRecord(expected)) {
    if (!isRecord(actual)) {
      messages.push(`${path} expected object but received ${typeof actual}`);
      return;
    }

    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);

    if (!allowExtraFields) {
      const extraKeys = actualKeys.filter((key) => !expectedKeys.includes(key));
      for (const extraKey of extraKeys) {
        messages.push(`${path}.${extraKey} was not expected`);
      }
    }

    for (const key of expectedKeys) {
      comparePartial(actual[key], expected[key], allowExtraFields, `${path}.${key}`, messages);
    }
    return;
  }

  if (!Object.is(actual, expected)) {
    messages.push(`${path} expected ${JSON.stringify(expected)} but received ${JSON.stringify(actual)}`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripSeamMetadata(metadata) {
  if (!isRecord(metadata)) {
    return metadata;
  }
  const seam = { ...metadata };
  delete seam.adapter;
  delete seam.artifacts;
  return seam;
}

/**
 * Applies the same comparator logic the runner uses: status check plus
 * per-surface partial comparison on output, error, diagnostics, and seam
 * metadata. Returns `{ passed, messages }` for the supplied normalized
 * result.
 */
function evaluateCase(caseJson, normalized) {
  const comparator = caseJson.expect.comparator;
  if (comparator !== "partial") {
    throw new Error(`Case ${caseJson.id} uses comparator "${comparator}"; sweep only supports "partial".`);
  }

  const allowExtraFields = caseJson.expect.allowExtraFields ?? true;
  const messages = [];

  if (caseJson.expect.status && normalized.status !== caseJson.expect.status) {
    messages.push(`expected status ${caseJson.expect.status} but received ${normalized.status}`);
  }

  comparePartial(normalized.output, caseJson.expect.output, allowExtraFields, "output", messages);
  comparePartial(normalized.error, caseJson.expect.error, allowExtraFields, "error", messages);
  comparePartial(normalized.diagnostics, caseJson.expect.diagnostics, allowExtraFields, "diagnostics", messages);
  comparePartial(stripSeamMetadata(normalized.metadata), caseJson.expect.metadata, allowExtraFields, "metadata", messages);

  return { passed: messages.length === 0, messages };
}

function buildRecallEnvelope(caseJson, rankingPolicy) {
  const input = caseJson.input ?? {};
  const recallRequest = { ...(input.recallRequest ?? {}) };
  if (rankingPolicy !== undefined) {
    recallRequest.rankingPolicy = rankingPolicy;
  }

  const envelope = {
    caseId: caseJson.id,
    memoryPool: input.memoryPool ?? [],
    recallRequest,
  };

  if (caseJson.description) envelope.description = caseJson.description;
  if (input.recallPath) envelope.recallPath = input.recallPath;
  if (input.sandbox) envelope.sandbox = input.sandbox;
  if (input.unified) envelope.unified = input.unified;
  if (input.options) envelope.options = input.options;

  return envelope;
}

function buildBeforeTurnEnvelope(caseJson) {
  const input = caseJson.input ?? {};
  const envelope = {
    caseId: caseJson.id,
    memoryPool: input.memoryPool ?? [],
    beforeTurnInput: input.beforeTurnInput,
  };

  if (caseJson.description) envelope.description = caseJson.description;
  if (input.sandbox) envelope.sandbox = input.sandbox;
  if (input.procedurePool) envelope.procedurePool = input.procedurePool;
  if (input.options) envelope.options = input.options;

  return envelope;
}

function normalizeRecallResponse(body) {
  if (body?.status === "ok") {
    return {
      status: "ok",
      output: body.result,
      diagnostics: body.diagnostics,
      error: undefined,
      metadata: body.metadata,
    };
  }

  return {
    status: "error",
    output: undefined,
    diagnostics: body?.diagnostics,
    error: body?.error ?? { code: "unknown", message: "missing error payload" },
    metadata: body?.metadata,
  };
}

function normalizeBeforeTurnResponse(body) {
  if (body?.status === "ok") {
    const normalizedStatus = body.output?.abstained === true ? "abstain" : "ok";
    return {
      status: normalizedStatus,
      output: body.output,
      diagnostics: body.diagnostics,
      error: undefined,
      metadata: body.metadata,
    };
  }

  return {
    status: "error",
    output: undefined,
    diagnostics: body?.diagnostics,
    error: body?.error ?? { code: "unknown", message: "missing error payload" },
    metadata: body?.metadata,
  };
}

async function postJson(path, payload) {
  const url = `${BASE_URL}${path}`;
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  const durationMs = Date.now() - startedAt;
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Non-JSON response from ${url}: status=${response.status}, body=${text.slice(0, 200)}`, { cause: error });
  }

  if (!response.ok && parsed?.status !== "error") {
    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 200)}`);
  }

  return { body: parsed, httpStatus: response.status, durationMs };
}

function topEntryId(normalized, endpoint) {
  if (endpoint === "recall") {
    if (Array.isArray(normalized.output?.entryIds) && normalized.output.entryIds.length > 0) {
      return normalized.output.entryIds[0];
    }
    return null;
  }

  if (normalized.output?.abstained === true) {
    return "abstain";
  }
  if (Array.isArray(normalized.output?.selectedEntryIds) && normalized.output.selectedEntryIds.length > 0) {
    return normalized.output.selectedEntryIds[0];
  }
  return "no-selection";
}

function classify(results) {
  const passed = (variant) => results[variant]?.verdict?.passed === true;
  const failed = (variant) => results[variant]?.verdict?.passed === false;

  if (passed("baseline")) {
    return "already_passing";
  }

  const kills = ["rrf_disabled", "neighborhood_disabled", "mmr_disabled"];
  const rescuers = kills.filter((id) => passed(id));

  if (rescuers.length === 1) {
    if (rescuers[0] === "rrf_disabled") return "rrf_induced";
    if (rescuers[0] === "neighborhood_disabled") return "neighborhood_induced";
    if (rescuers[0] === "mmr_disabled") return "mmr_induced";
  }

  if (rescuers.length >= 2) {
    return "combined";
  }

  if (results.cross_encoder_disabled && failed("cross_encoder_disabled")) {
    return "threshold_induced";
  }

  if (!results.cross_encoder_disabled) {
    return "threshold_induced";
  }

  return "combined";
}

function crossEncoderRescued(results) {
  if (!results.cross_encoder_disabled) {
    return "n/a";
  }

  const baselinePass = results.baseline?.verdict?.passed === true;
  const withoutCrossEncoderPass = results.cross_encoder_disabled?.verdict?.passed === true;

  if (baselinePass && !withoutCrossEncoderPass) {
    return "yes";
  }
  if (baselinePass && withoutCrossEncoderPass) {
    return "no";
  }
  return "no";
}

async function loadCase(relPath) {
  const absolute = join(EVALS_ROOT, relPath);
  const raw = await readFile(absolute, "utf-8");
  return JSON.parse(raw);
}

async function ensureServerReachable() {
  try {
    const response = await fetch(`${BASE_URL}/internal/evals/recall/run`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
    return response.status !== undefined;
  } catch (error) {
    throw new Error(
      `Internal eval server not reachable at ${BASE_URL}. Start it with:\n` +
        `  AGENR_CONFIG_PATH=$HOME/.openclaw-sandbox/agenr-data/config.json node dist/internal-eval-server.js\n` +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function shortStatus(passed) {
  return passed ? "pass" : "fail";
}

function renderClassificationRow(row, verdicts, classification, ceRescued) {
  const baseline = verdicts.baseline ? shortStatus(verdicts.baseline.passed) : "n/a";
  const rrf = verdicts.rrf_disabled ? shortStatus(verdicts.rrf_disabled.passed) : "n/a";
  const neighborhood = verdicts.neighborhood_disabled ? shortStatus(verdicts.neighborhood_disabled.passed) : "n/a";
  const mmr = verdicts.mmr_disabled ? shortStatus(verdicts.mmr_disabled.passed) : "n/a";
  return `| ${row.row} | \`${row.caseId}\` | ${baseline} | ${rrf} | ${neighborhood} | ${mmr} | ${classification} | ${ceRescued} | ${row.note ?? ""} |`;
}

async function main() {
  await ensureServerReachable();

  const runId = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
  const runDir = join(OUTPUT_ROOT, runId);
  const runsDir = join(runDir, "runs");
  await mkdir(runsDir, { recursive: true });

  console.log(`[sweep] base url: ${BASE_URL}`);
  console.log(`[sweep] evals root: ${EVALS_ROOT}`);
  console.log(`[sweep] output: ${runDir}`);

  const rows = [];
  const detailEntries = [];
  const runCache = new Map();

  for (const row of INVENTORY) {
    const cacheKey = `${row.caseFile}::${row.endpoint}`;
    let variantResults = runCache.get(cacheKey);

    if (!variantResults) {
      variantResults = {};
      const caseJson = await loadCase(row.caseFile);
      const variants = row.endpoint === "recall" ? RECALL_VARIANTS : BEFORE_TURN_VARIANTS;

      for (const variant of variants) {
        console.log(`[sweep] row=${row.row} case=${row.caseId} variant=${variant.id}`);
        const envelope = row.endpoint === "recall" ? buildRecallEnvelope(caseJson, variant.policy) : buildBeforeTurnEnvelope(caseJson);
        const { body, httpStatus, durationMs } = await postJson(row.endpoint === "recall" ? RECALL_PATH : BEFORE_TURN_PATH, envelope);
        const normalized = row.endpoint === "recall" ? normalizeRecallResponse(body) : normalizeBeforeTurnResponse(body);
        const verdict = evaluateCase(caseJson, normalized);

        variantResults[variant.id] = {
          verdict,
          normalized,
          topRankedId: topEntryId(normalized, row.endpoint),
          httpStatus,
          durationMs,
        };

        const runFile = join(runsDir, `row-${String(row.row).padStart(2, "0")}-${variant.id}.json`);
        await writeFile(
          runFile,
          JSON.stringify(
            {
              row: row.row,
              caseId: row.caseId,
              manifest: row.manifest,
              endpoint: row.endpoint,
              variant: variant.id,
              policy: variant.policy,
              envelope,
              response: body,
              normalized,
              verdict,
              httpStatus,
              durationMs,
            },
            null,
            2,
          ),
        );
      }

      runCache.set(cacheKey, variantResults);
    } else {
      console.log(`[sweep] row=${row.row} case=${row.caseId} reusing cached run`);
    }

    const classification = classify(variantResults);
    const ceRescued = crossEncoderRescued(variantResults);

    const verdicts = Object.fromEntries(
      Object.entries(variantResults).map(([variantId, payload]) => [
        variantId,
        { passed: payload.verdict.passed, topRankedId: payload.topRankedId, messages: payload.verdict.messages },
      ]),
    );

    rows.push({
      row: row.row,
      caseId: row.caseId,
      manifest: row.manifest,
      endpoint: row.endpoint,
      classification,
      crossEncoderRescued: ceRescued,
      verdicts,
    });

    for (const [variantId, payload] of Object.entries(variantResults)) {
      detailEntries.push({
        caseId: row.caseId,
        manifest: row.manifest,
        stageUnderTest: variantId,
        passed: payload.verdict.passed,
        topRankedId: payload.topRankedId,
        row: row.row,
      });
    }
  }

  await writeFile(join(runDir, "ledger.json"), JSON.stringify(rows, null, 2));

  const markdownLines = [];
  markdownLines.push("| # | Case ID | Baseline | rrf=disabled | neighborhood=disabled | mmr=disabled | Classification | cross_encoder_rescued | Notes |");
  markdownLines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    markdownLines.push(renderClassificationRow(row, row.verdicts, row.classification, row.crossEncoderRescued));
  }
  const classificationMd = markdownLines.join("\n");
  await writeFile(join(runDir, "classification.md"), `${classificationMd}\n`);

  const detailMdLines = [];
  detailMdLines.push("| Case ID | Manifest | Stage Under Test | Passed? | Top Ranked ID | Note |");
  detailMdLines.push("| --- | --- | --- | --- | --- | --- |");
  for (const entry of detailEntries) {
    detailMdLines.push(
      `| \`${entry.caseId}\` | \`${entry.manifest}\` | ${entry.stageUnderTest} | ${shortStatus(entry.passed)} | \`${entry.topRankedId}\` | row ${entry.row} |`,
    );
  }
  await writeFile(join(runDir, "detail.md"), `${detailMdLines.join("\n")}\n`);

  console.log(`\n[sweep] runId: ${runId}`);
  console.log(`[sweep] ledger: ${join(runDir, "ledger.json")}`);
  console.log(`[sweep] classification md: ${join(runDir, "classification.md")}`);
  console.log(`[sweep] detail md: ${join(runDir, "detail.md")}`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? String(error));
  process.exit(1);
});
