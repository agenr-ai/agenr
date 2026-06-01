import type { ClaimCentricRecallEntry, UnifiedRecallResult } from "../../app/recall/index.js";
import { buildEntryRecallPreview, ENTRY_PREVIEW_MAX_CHARS, recallResultHasTruncatedEntryPreviews, truncate } from "./memory-tool-format.js";

/**
 * Formats unified recall results into sectioned tool-readable text.
 *
 * @param result - Unified recall result payload.
 * @returns Human-readable recall text.
 */
export function formatUnifiedRecallResults(result: UnifiedRecallResult): string {
  const lines = [
    "Recall Route",
    `requested=${result.routing.requested} detected=${result.routing.detectedIntent} queried=${result.routing.queried.join(", ") || "none"}`,
    result.routing.reason,
    "",
  ];

  if (result.timeWindow) {
    lines.push("Resolved Time Window");
    lines.push(`${result.timeWindow.start} -> ${result.timeWindow.end} (${result.timeWindow.timezone}) from ${JSON.stringify(result.timeWindow.resolvedFrom)}`);
    lines.push("");
  }

  if (result.asOf) {
    lines.push("As Of");
    lines.push(result.asOf);
    lines.push("");
  }

  if (result.routing.queried.includes("procedures") || result.procedure || result.procedureCandidates.length > 0 || result.procedureNotices.length > 0) {
    appendProcedureMatches(lines, result);
    lines.push("");
  }

  const renderEntriesFirst = result.routing.detectedIntent === "historical_state";
  if (renderEntriesFirst) {
    appendEntryMatches(lines, result);
    lines.push("");
    appendClaimTransitions(lines, result);
    lines.push("");
    appendEpisodeMatches(lines, result);
  } else {
    appendEpisodeMatches(lines, result);
    lines.push("");
    appendEntryMatches(lines, result);
    lines.push("");
    appendClaimTransitions(lines, result);
  }

  if (recallResultHasTruncatedEntryPreviews(result)) {
    lines.push("");
    lines.push("Fetch Guidance");
    lines.push("One or more entry previews were truncated. Call agenr_fetch with id when exact stored wording is required.");
  }

  if (result.notices.length > 0) {
    lines.push("");
    lines.push("Notices");
    for (const notice of result.notices) {
      lines.push(`- ${notice}`);
    }
  }

  return lines.join("\n");
}

/** Append the procedure result section in tool-readable text format. */
function appendProcedureMatches(lines: string[], result: UnifiedRecallResult): void {
  lines.push("Procedure Matches");
  if (!result.procedure && result.procedureCandidates.length === 0) {
    lines.push("None.");
  } else {
    if (result.procedure) {
      appendCanonicalProcedure(lines, result.procedure, result.procedureCandidates);
    } else {
      lines.push("Canonical procedure: none.");
    }

    const additionalCandidates = result.procedureCandidates.filter((candidate) => candidate.procedure.id !== result.procedure?.id);
    if (additionalCandidates.length > 0) {
      lines.push("Other Candidates");
      for (const [index, candidate] of additionalCandidates.entries()) {
        lines.push(
          `${index + 1}. ${candidate.procedure.procedure_key} | ${candidate.procedure.title} | score ${candidate.score.toFixed(2)} | lexical=${candidate.scores.lexical.toFixed(2)} | vector=${candidate.scores.vector.toFixed(2)}`,
        );
      }
    }
  }

  if (result.procedureNotices.length > 0) {
    lines.push("Procedure Notices");
    for (const notice of result.procedureNotices) {
      lines.push(`- ${notice}`);
    }
  }
}

/** Append the entry result section in tool-readable text format. */
function appendEntryMatches(lines: string[], result: UnifiedRecallResult): void {
  lines.push("Entry Matches");
  if (result.projectedEntries.length === 0) {
    lines.push("None.");
    return;
  }

  for (const [familyIndex, family] of result.entryFamilies.entries()) {
    lines.push(
      family.claimKey
        ? `Family ${familyIndex + 1}. claim_key=${family.claimKey} | slot_policy=${family.slotPolicy} | primary=${family.primary.entryId} | subject=${family.subject}`
        : `Standalone ${familyIndex + 1}. ${family.primary.entryId} | subject=${family.subject}`,
    );
    for (const [entryIndex, entry] of family.entries.entries()) {
      const preview = buildEntryRecallPreview(entry.recall.entry.content);
      lines.push(
        `   ${entryIndex + 1}. ${entry.entryId} | ${entry.recall.entry.type} | ${entry.recall.entry.subject} | score ${entry.recall.score.toFixed(2)} | state=${entry.memoryState} | claim_status=${formatClaimStatus(entry.claimStatus)}`,
      );
      lines.push(`      ${preview.contentPreview}`);
      lines.push(`      content_chars=${preview.contentChars} preview_truncated=${preview.previewTruncated ? "true" : "false"}`);
      lines.push(`      freshness=${entry.freshness.label}`);
      const provenance = formatProjectedEntryProvenance(entry);
      if (provenance) {
        lines.push(`      provenance=${provenance}`);
      }
      lines.push(`      why_surfaced=${entry.whySurfaced.summary}`);
    }
  }
}

/** Append the episode result section in tool-readable text format. */
function appendEpisodeMatches(lines: string[], result: UnifiedRecallResult): void {
  lines.push("Episode Matches");
  if (result.episodes.length === 0) {
    lines.push("None.");
    return;
  }

  for (const [index, episode] of result.episodes.entries()) {
    lines.push(
      `${index + 1}. ${episode.episode.id} | ${episode.episode.source} | ${episode.episode.startedAt} -> ${episode.episode.endedAt ?? episode.episode.startedAt} | score ${episode.score.toFixed(2)}`,
    );
    lines.push(`   ${index < 3 ? episode.episode.summary.trim() : truncate(episode.episode.summary.trim(), ENTRY_PREVIEW_MAX_CHARS)}`);
    lines.push(`   why_matched=${describeEpisodeMatch(episode)}`);
  }
}

/** Append one canonical procedure block with structured authored fields. */
function appendCanonicalProcedure(
  lines: string[],
  procedure: NonNullable<UnifiedRecallResult["procedure"]>,
  candidates: UnifiedRecallResult["procedureCandidates"],
): void {
  const leadCandidate = candidates.find((candidate) => candidate.procedure.id === procedure.id);
  lines.push(
    leadCandidate
      ? `Canonical Procedure. ${procedure.procedure_key} | ${procedure.title} | score ${leadCandidate.score.toFixed(2)}`
      : `Canonical Procedure. ${procedure.procedure_key} | ${procedure.title}`,
  );
  lines.push(`   goal=${procedure.goal}`);
  appendLabeledList(lines, "when_to_use", procedure.when_to_use);
  appendLabeledList(lines, "when_not_to_use", procedure.when_not_to_use);
  appendLabeledList(lines, "prerequisites", procedure.prerequisites);

  lines.push("   steps");
  for (const [index, step] of procedure.steps.entries()) {
    lines.push(`   ${index + 1}. [${step.kind}] ${step.instruction}`);
    const stepDetails = formatProcedureStepDetails(step);
    if (stepDetails.length > 0) {
      for (const detail of stepDetails) {
        lines.push(`      ${detail}`);
      }
    }
  }

  appendLabeledList(lines, "verification", procedure.verification);
  appendLabeledList(lines, "failure_modes", procedure.failure_modes);
  lines.push("   sources");
  for (const source of procedure.sources) {
    lines.push(`   - ${formatProcedureSource(source)}`);
  }
}

/** Append the compact claim-transition explanation section. */
function appendClaimTransitions(lines: string[], result: UnifiedRecallResult): void {
  lines.push("Claim Transitions");
  if (result.claimTransitions.length === 0) {
    lines.push("None.");
    return;
  }

  for (const [index, transition] of result.claimTransitions.entries()) {
    lines.push(
      `${index + 1}. family=${transition.claimKey ?? transition.familyKey} | slot_policy=${transition.slotPolicy}${transition.currentEntryId ? ` | current=${transition.currentEntryId}` : ""}${
        transition.priorEntryId ? ` | prior=${transition.priorEntryId}` : ""
      }`,
    );
    lines.push(`   ${transition.summary}`);
    if (transition.episodeContext) {
      lines.push(
        `   episode=${transition.episodeContext.episodeId} | ${transition.episodeContext.startedAt} -> ${transition.episodeContext.endedAt ?? transition.episodeContext.startedAt}`,
      );
      lines.push(`   ${truncate(transition.episodeContext.summary.trim(), ENTRY_PREVIEW_MAX_CHARS)}`);
    }
  }
}

/** Appends one short labeled string list inside a structured procedure block. */
function appendLabeledList(lines: string[], label: string, values: string[]): void {
  lines.push(`   ${label}`);
  if (values.length === 0) {
    lines.push("   - none");
    return;
  }

  for (const value of values) {
    lines.push(`   - ${value}`);
  }
}

/** Formats the structured details that matter for one authored procedure step. */
function formatProcedureStepDetails(step: UnifiedRecallResult["procedureCandidates"][number]["procedure"]["steps"][number]): string[] {
  switch (step.kind) {
    case "run_command":
      return [`command=${step.command}`];
    case "read_reference":
      return [`ref=${formatProcedureSource(step.ref)}`];
    case "inspect_state":
      return [step.target ? `target=${step.target}` : undefined, step.query ? `query=${step.query}` : undefined].filter(
        (value): value is string => value !== undefined,
      );
    case "edit_file":
      return [`path=${step.path}`, `edit=${step.edit}`];
    case "ask_user":
      return [`prompt=${step.prompt}`];
    case "invoke_tool":
      return [step.tool ? `tool=${step.tool}` : undefined, step.arguments ? `arguments=${JSON.stringify(step.arguments)}` : undefined].filter(
        (value): value is string => value !== undefined,
      );
    case "verify":
      return step.checks.map((check) => `check=${check}`);
    default:
      return [];
  }
}

/** Formats one procedure provenance or reference source into concise text. */
function formatProcedureSource(source: NonNullable<UnifiedRecallResult["procedure"]>["sources"][number]): string {
  const parts = [source.kind, source.label, source.path, source.locator].filter((value): value is string => Boolean(value && value.length > 0));
  return parts.join(" | ");
}

/** Formats a short explanation for why an episode matched recall. */
function describeEpisodeMatch(result: UnifiedRecallResult["episodes"][number]): string {
  if (result.scores.semantic > 0 && result.scores.temporal > 0) {
    return "Semantic match within the resolved time window.";
  }

  if (result.scores.semantic > 0) {
    return "Semantic match to the episode summary.";
  }

  if (result.scores.temporal > 0) {
    return "Session overlaps the resolved time window.";
  }

  return "Matched episodic recall ranking.";
}

/** Formats the normalized claim-status label for user-facing text output. */
function formatClaimStatus(status: ClaimCentricRecallEntry["claimStatus"]): string {
  return status === "no_key" ? "no-key" : status;
}

/** Formats provenance cues for one projected recall row. */
function formatProjectedEntryProvenance(entry: ClaimCentricRecallEntry): string {
  const parts = [
    entry.provenance.supersededById ? `superseded_by=${entry.provenance.supersededById}` : undefined,
    entry.provenance.supersessionKind ? `kind=${entry.provenance.supersessionKind}` : undefined,
    entry.provenance.supersessionReason ? `reason=${truncate(entry.provenance.supersessionReason, 120)}` : undefined,
    entry.provenance.supportSourceKind ? `support=${entry.provenance.supportSourceKind}` : undefined,
    entry.provenance.supportMode ? `support_mode=${entry.provenance.supportMode}` : undefined,
    entry.provenance.supportObservedAt ? `observed=${entry.provenance.supportObservedAt}` : undefined,
    entry.provenance.supportLocator ? `locator=${truncate(entry.provenance.supportLocator, 120)}` : undefined,
  ].filter((value): value is string => value !== undefined);

  return parts.join(" | ");
}
