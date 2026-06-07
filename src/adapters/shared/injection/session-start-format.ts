import type { SessionStartPatch, SessionStartPatchItem } from "../../../app/session-start/index.js";

import { formatInjectionDurableBodyLines, formatInjectionDurableHeader } from "./durable-lines.js";
import { wrapAgenrMemoryContext } from "./memory-context.js";

/**
 * Formats session-start recall results into prompt text for host injection.
 *
 * @param patch - Structured session-start patch returned by the app layer.
 * @returns Prompt-ready text, or an empty string when nothing should be injected.
 */
export function formatAgenrSessionStartRecall(patch: SessionStartPatch): string {
  if (patch.durableMemory.length === 0) {
    return "";
  }

  const lines: string[] = [];

  const durableSections = buildSections(patch);
  if (durableSections.length > 0) {
    const recallLines: string[] = [
      "## Agenr Session Recall",
      "Use this as prior context. Confirm anything important if the current conversation conflicts with it.",
      "",
    ];

    for (const section of durableSections) {
      recallLines.push(`### ${section.title}`);

      for (const item of section.items) {
        recallLines.push(formatInjectionDurableHeader(item));
        recallLines.push(...formatInjectionDurableBodyLines(item));
      }

      recallLines.push("");
    }

    lines.push(wrapAgenrMemoryContext(recallLines.join("\n").trim()));
  }

  return lines.join("\n").trim();
}

/**
 * Builds the ordered memory sections that should appear in the system prompt.
 *
 * @param patch - Structured patch payload grouped by source kind.
 * @returns Non-empty prompt sections ready for rendering.
 */
export function buildSections(patch: SessionStartPatch): Array<{ title: string; items: SessionStartPatchItem[] }> {
  const sections: Array<{ title: string; items: SessionStartPatchItem[] }> = [];

  const profileDurables = patch.durableMemory.filter((item) => item.sourceKind === "profile");
  if (profileDurables.length > 0) {
    sections.push({ title: "Profile Memory", items: profileDurables });
  }

  const directiveDurables = patch.durableMemory.filter((item) => item.sourceKind === "directive");
  if (directiveDurables.length > 0) {
    sections.push({ title: "Memory Directives", items: directiveDurables });
  }

  const coreDurables = patch.durableMemory.filter((item) => item.sourceKind === "core");
  if (coreDurables.length > 0) {
    sections.push({ title: "Core Memory", items: coreDurables });
  }

  const artifactRecallDurables = patch.durableMemory.filter((item) => item.sourceKind === "artifact_recall");
  if (artifactRecallDurables.length > 0) {
    sections.push({ title: "Relevant Durable Memory", items: artifactRecallDurables });
  }

  return sections;
}
