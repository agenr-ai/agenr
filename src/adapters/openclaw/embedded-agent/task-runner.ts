import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_MODEL, DEFAULT_PROVIDER, parseModelRef, resolveAgentEffectiveModelPrimary, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";

import type { AgenrOpenClawHost } from "../types.js";

const EMBEDDED_AGENT_TIMEOUT = Symbol("embedded-agent-timeout");

/**
 * Resolved OpenClaw embedded-agent execution facts for one task run.
 */
export interface OpenClawEmbeddedAgentExecution {
  /**
   * OpenClaw agent identifier that will execute the task.
   */
  agentId: string;
  /**
   * Absolute OpenClaw agent directory for the resolved agent.
   */
  agentDir: string;
  /**
   * Concrete model id used for the embedded-agent run.
   */
  model: string;
  /**
   * Original configured model ref when one was available.
   */
  modelRef?: string;
  /**
   * Concrete provider id used for the embedded-agent run.
   */
  provider: string;
  /**
   * Absolute OpenClaw workspace directory for the resolved agent.
   */
  workspaceDir: string;
}

/**
 * Outcome returned after one embedded-agent text task attempt.
 */
export type OpenClawEmbeddedAgentTextTaskResult =
  | {
      status: "completed";
      text: string;
    }
  | {
      status: "unavailable";
    }
  | {
      status: "timeout";
    }
  | {
      status: "empty_response";
    };

/**
 * Resolves the OpenClaw agent, provider, and model used for an embedded-agent task.
 *
 * @param params - Host runtime, optional agent override, and optional model override.
 * @returns Concrete execution facts for the embedded-agent call.
 */
export function resolveOpenClawEmbeddedAgentExecution(params: {
  openClaw: AgenrOpenClawHost;
  requestedAgentId?: string;
  modelOverride?: string;
  invalidOverrideLabel: string;
}): OpenClawEmbeddedAgentExecution {
  const agentId = params.requestedAgentId?.trim() || resolveDefaultAgentId(params.openClaw.config);
  if (params.modelOverride) {
    const parsedModelRef = parseModelRef(params.modelOverride, DEFAULT_PROVIDER);
    if (!parsedModelRef) {
      throw new Error(`Invalid ${params.invalidOverrideLabel}: ${params.modelOverride}`);
    }

    return {
      agentId,
      agentDir: params.openClaw.runtime.agent.resolveAgentDir(params.openClaw.config, agentId),
      workspaceDir: params.openClaw.runtime.agent.resolveAgentWorkspaceDir(params.openClaw.config, agentId),
      modelRef: params.modelOverride,
      provider: parsedModelRef.provider,
      model: parsedModelRef.model,
    };
  }

  const modelRef = resolveAgentEffectiveModelPrimary(params.openClaw.config, agentId);
  const parsedModelRef = modelRef ? parseModelRef(modelRef, DEFAULT_PROVIDER) : null;

  return {
    agentId,
    agentDir: params.openClaw.runtime.agent.resolveAgentDir(params.openClaw.config, agentId),
    workspaceDir: params.openClaw.runtime.agent.resolveAgentWorkspaceDir(params.openClaw.config, agentId),
    modelRef,
    provider: parsedModelRef?.provider ?? DEFAULT_PROVIDER,
    model: parsedModelRef?.model ?? DEFAULT_MODEL,
  };
}

/**
 * Formats a resolved provider/model pair as a stable identifier.
 *
 * @param execution - Resolved embedded-agent execution facts.
 * @returns Stable `provider/model` identifier.
 */
export function formatOpenClawEmbeddedAgentModel(execution: Pick<OpenClawEmbeddedAgentExecution, "provider" | "model">): string {
  return `${execution.provider}/${execution.model}`;
}

/**
 * Runs one embedded-agent task that is expected to return plain text.
 *
 * The helper owns temp session-file lifecycle, response extraction, and a
 * local timeout guard around the OpenClaw runtime call.
 *
 * @param params - Embedded-agent execution facts plus task payload.
 * @returns Standardized task outcome for the caller to interpret.
 */
export async function runOpenClawEmbeddedAgentTextTask(params: {
  openClaw: AgenrOpenClawHost;
  execution: OpenClawEmbeddedAgentExecution;
  prompt: string;
  systemPrompt: string;
  timeoutMs: number;
  runIdPrefix: string;
  sessionKey: string;
  tempDirPrefix: string;
}): Promise<OpenClawEmbeddedAgentTextTaskResult> {
  const runEmbeddedPiAgent = params.openClaw.runtime.agent.runEmbeddedPiAgent;
  if (typeof runEmbeddedPiAgent !== "function") {
    return {
      status: "unavailable",
    };
  }

  const tempSessionFile = await createTempEmbeddedAgentSessionFile(params.tempDirPrefix);
  try {
    const runId = `${params.runIdPrefix}-${Date.now()}`;
    const result = await awaitWithTimeout(
      runEmbeddedPiAgent({
        sessionId: runId,
        sessionKey: params.sessionKey,
        agentId: params.execution.agentId,
        sessionFile: tempSessionFile,
        workspaceDir: params.execution.workspaceDir,
        agentDir: params.execution.agentDir,
        config: params.openClaw.config,
        prompt: params.prompt,
        provider: params.execution.provider,
        model: params.execution.model,
        timeoutMs: params.timeoutMs,
        runId,
        disableTools: true,
        extraSystemPrompt: params.systemPrompt,
      }),
      params.timeoutMs,
    );
    if (result === EMBEDDED_AGENT_TIMEOUT) {
      return {
        status: "timeout",
      };
    }

    const text = extractEmbeddedAgentText(result).trim();
    if (!text) {
      return {
        status: "empty_response",
      };
    }

    return {
      status: "completed",
      text,
    };
  } finally {
    await cleanupTempEmbeddedAgentSessionFile(tempSessionFile);
  }
}

/**
 * Resolves a promise while allowing the caller to abandon the result after a timeout.
 *
 * @param promise - In-flight embedded-agent call.
 * @param timeoutMs - Maximum wait time in milliseconds.
 * @returns Promise result or the timeout sentinel.
 */
async function awaitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof EMBEDDED_AGENT_TIMEOUT> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve(EMBEDDED_AGENT_TIMEOUT);
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

/**
 * Creates the temporary session file path required by the embedded-agent API.
 *
 * @param tempDirPrefix - Prefix used for the temporary directory.
 * @returns Absolute temporary session path.
 */
async function createTempEmbeddedAgentSessionFile(tempDirPrefix: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), tempDirPrefix));
  return path.join(tempDir, "session.jsonl");
}

/**
 * Removes temporary embedded-agent runner state.
 *
 * @param tempSessionFile - Temporary session file path.
 * @returns Promise that resolves after cleanup completes.
 */
async function cleanupTempEmbeddedAgentSessionFile(tempSessionFile: string): Promise<void> {
  try {
    await fs.rm(path.dirname(tempSessionFile), {
      recursive: true,
      force: true,
    });
  } catch {
    // Ignore cleanup failures for temporary embedded-agent state.
  }
}

/**
 * Extracts the first non-empty text payload returned by the embedded-agent API.
 *
 * @param result - Embedded-agent response payload.
 * @returns First non-empty text body, or an empty string when none exists.
 */
function extractEmbeddedAgentText(result: unknown): string {
  if (!isEmbeddedAgentTextPayloadResult(result)) {
    return "";
  }

  return result.payloads?.find((payload) => payload.text?.trim())?.text ?? "";
}

/**
 * Checks whether an embedded-agent result carries text payloads.
 *
 * @param value - Unknown result value from the OpenClaw runtime.
 * @returns `true` when the value exposes the expected payload shape.
 */
function isEmbeddedAgentTextPayloadResult(value: unknown): value is { payloads?: Array<{ text?: string }> } {
  if (!value || typeof value !== "object" || !("payloads" in value)) {
    return false;
  }

  const payloads = value.payloads;
  if (payloads === undefined) {
    return true;
  }

  return (
    Array.isArray(payloads) &&
    payloads.every(
      (payload) => payload && typeof payload === "object" && (!("text" in payload) || payload.text === undefined || typeof payload.text === "string"),
    )
  );
}
