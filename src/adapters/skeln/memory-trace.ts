import type { WorkingContextAuditPointer } from "../../app/working-memory/projection.js";

/** Describes one agenr memory surface observed during a prompt turn. */
export type MemoryTraceKind = "working_context" | "session_start_recall" | "before_turn_recall" | "system_prompt";

/** Describes whether a memory surface changed provider context for the turn. */
export type MemoryTraceAction = "injected" | "skipped" | "failed";

/** Structured audit event for one agenr memory decision on a turn. */
export interface MemoryTraceEvent {
  kind: MemoryTraceKind;
  action: MemoryTraceAction;
  reason?: string;
  bytes?: number;
  summary?: string;
  preview?: string;
  workingSetId?: string;
  revision?: number;
  sourceRef?: string;
}

const AGENR_MEMORY_DOCTRINE_HEADER = "## Memory Recall";

/** Inputs used to build before-agent-start memory trace events. */
export interface BeforeAgentStartMemoryTraceInput {
  /** Original system prompt before doctrine append. */
  baseSystemPrompt?: string;
  /** System prompt after doctrine append. */
  systemPrompt?: string;
  /** Recall trace kind when recall ran or was skipped. */
  recallKind?: Extract<MemoryTraceKind, "session_start_recall" | "before_turn_recall">;
  /** Rendered recall text when injection succeeded. */
  recallText?: string;
  /** Stable skip reason when recall was disabled or not applicable. */
  recallSkippedReason?: string;
  /** Failure reason when recall resolution threw. */
  recallFailureReason?: string;
  /** Working-context trace for the same turn. */
  workingContextTrace?: MemoryTraceEvent;
}

/** Builds one injected memory trace event. */
export function traceMemoryInjected(
  kind: MemoryTraceKind,
  input: {
    bytes?: number;
    summary?: string;
    preview?: string;
    workingSetId?: string;
    revision?: number;
    sourceRef?: string;
  },
): MemoryTraceEvent {
  return {
    kind,
    action: "injected",
    ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.preview ? { preview: input.preview } : {}),
    ...(input.workingSetId ? { workingSetId: input.workingSetId } : {}),
    ...(input.revision !== undefined ? { revision: input.revision } : {}),
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
  };
}

/** Builds one skipped memory trace event. */
export function traceMemorySkipped(kind: MemoryTraceKind, reason: string, summary?: string): MemoryTraceEvent {
  return {
    kind,
    action: "skipped",
    reason,
    ...(summary ? { summary } : {}),
  };
}

/** Builds one failed memory trace event. */
export function traceMemoryFailed(kind: MemoryTraceKind, reason: string): MemoryTraceEvent {
  return {
    kind,
    action: "failed",
    reason,
  };
}

/** Builds memory trace events for one Skeln before_agent_start turn. */
export function buildBeforeAgentStartMemoryTrace(input: BeforeAgentStartMemoryTraceInput): MemoryTraceEvent[] {
  const recallText = input.recallText?.trim();
  const hasRecall = recallText !== undefined && recallText.length > 0;
  const memoryTrace: MemoryTraceEvent[] = [];

  if (input.baseSystemPrompt !== undefined && input.systemPrompt !== undefined) {
    const doctrineTrace = traceSystemPromptDoctrineInjected(input.baseSystemPrompt, input.systemPrompt);
    if (doctrineTrace) {
      memoryTrace.push(doctrineTrace);
    }
  }

  if (input.workingContextTrace) {
    memoryTrace.push(input.workingContextTrace);
  }

  if (input.recallKind) {
    if (input.recallFailureReason) {
      memoryTrace.push(traceMemoryFailed(input.recallKind, input.recallFailureReason));
    } else if (input.recallSkippedReason) {
      memoryTrace.push(traceMemorySkipped(input.recallKind, input.recallSkippedReason));
    } else if (hasRecall && recallText) {
      memoryTrace.push(
        traceMemoryInjected(input.recallKind, {
          bytes: recallText.length,
          summary: input.recallKind === "session_start_recall" ? "session-start recall injected" : "before-turn recall injected",
          preview: recallText,
        }),
      );
    } else {
      memoryTrace.push(traceMemorySkipped(input.recallKind, "no matching entries"));
    }
  }

  return memoryTrace;
}

/** Builds a working-context trace from one audit pointer and rendered content. */
export function traceWorkingContextInjected(audit: WorkingContextAuditPointer | undefined, content: string): MemoryTraceEvent {
  return traceMemoryInjected("working_context", {
    bytes: audit?.bytes ?? content.length,
    summary: audit?.summary,
    preview: content,
    workingSetId: audit?.workingSetId,
    revision: audit?.revision,
    sourceRef: audit?.sourceRef,
  });
}

/** Builds a system-prompt trace when agenr doctrine is appended. */
export function traceSystemPromptDoctrineInjected(baseSystemPrompt: string, updatedSystemPrompt: string): MemoryTraceEvent | undefined {
  if (updatedSystemPrompt === baseSystemPrompt || !updatedSystemPrompt.includes(AGENR_MEMORY_DOCTRINE_HEADER)) {
    return undefined;
  }

  const doctrineIndex = updatedSystemPrompt.indexOf(AGENR_MEMORY_DOCTRINE_HEADER);
  const doctrine = doctrineIndex === -1 ? "" : updatedSystemPrompt.slice(doctrineIndex).trim();
  return traceMemoryInjected("system_prompt", {
    bytes: doctrine.length,
    summary: "agenr memory doctrine appended",
    preview: doctrine,
  });
}
