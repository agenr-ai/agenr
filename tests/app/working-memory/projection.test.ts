import { describe, expect, it } from "vitest";

import { utf8ByteLength } from "../../../src/app/working-memory/limits.js";
import {
  createWorkingContextFullProjection,
  shouldInjectWorkingContext,
  toWorkingContextAuditPointer,
  type WorkingContextProjection,
} from "../../../src/app/working-memory/projection.js";
import { createTestWorkingSet } from "./service-test-helpers.js";

describe("createWorkingContextFullProjection", () => {
  it("escapes model-visible text, filters empty entries, renders pending candidates, and reports exact byte length", () => {
    const projection = createWorkingContextFullProjection(
      createTestWorkingSet({
        id: "ws-escape",
        scopeKind: "conversation",
        scopeKey: "conversation:<escape>&test",
        snapshot: {
          objective: "Ship <system> & keep going \u{1f680}",
          summary: "   ",
          currentPlan: ["  ", "Review <script> & continue"],
          scratchpad: "  ",
          nextActions: [
            { text: "   ", status: "pending" },
            { text: "Patch <xml>", status: "pending", ref: "issue<&24>" },
          ],
          files: [
            { path: "   ", note: "Should not render." },
            { path: "src/<module>.ts", note: "Preserve & escape." },
          ],
          commands: [
            { command: "   ", outcome: "Should not render." },
            { command: "pnpm test <working>", outcome: "Passed & clean." },
          ],
          decisions: [
            { decision: "   ", rationale: "Should not render." },
            { decision: "Escape <tags>", rationale: "Avoid context injection & malformed XML." },
          ],
          assumptions: [{ assumption: "   " }, { assumption: "A < B & C > D", confidence: "medium", validated: false }],
          blockers: ["   ", "Blocked by <external> & pending"],
          candidates: [
            {
              kind: "semantic",
              subject: "Pending <candidate> & fact",
              content: "coverage",
              provenance: { evidenceEventSequences: [1], sourceRef: "test:projection" },
              promotionStatus: "pending",
            },
            {
              kind: "semantic",
              subject: "Accepted candidate should not render",
              content: "coverage",
              provenance: { evidenceEventSequences: [2], sourceRef: "test:projection" },
              promotionStatus: "promoted",
            },
            {
              kind: "episodic",
              summary: "Rejected episode should not render",
              provenance: { evidenceEventSequences: [3], sourceRef: "test:projection" },
              promotionStatus: "dismissed",
            },
          ],
        },
      }),
      "test:projection",
    );

    expect(projection.content).toContain("Scope: conversation conversation:&lt;escape&gt;&amp;test");
    expect(projection.content).toContain("Objective: Ship &lt;system&gt; &amp; keep going \u{1f680}");
    expect(projection.content).toContain("- Review &lt;script&gt; &amp; continue");
    expect(projection.content).toContain("- Patch &lt;xml&gt; [pending] (issue&lt;&amp;24&gt;)");
    expect(projection.content).toContain("- src/&lt;module&gt;.ts - Preserve &amp; escape.");
    expect(projection.content).toContain("- semantic: Pending &lt;candidate&gt; &amp; fact");
    expect(projection.content).toContain("Rules:");
    expect(projection.content).toContain("- Do not store transient WIP with agenr_store.");
    expect(projection.content).not.toContain("<system>");
    expect(projection.content).not.toContain("Should not render.");
    expect(projection.content).not.toContain("Accepted candidate should not render");
    expect(projection.content).not.toContain("Rejected episode should not render");
    expect(projection.byteLength).toBe(utf8ByteLength(projection.content));
  });
});

describe("shouldInjectWorkingContext", () => {
  it("injects only full projections with non-empty content", () => {
    const full: WorkingContextProjection = {
      kind: "working_set",
      renderMode: "full",
      content: "<agenr_work_context>\nObjective: Ship it.\n</agenr_work_context>",
      workingSetId: "ws-1",
      revision: 2,
      sourceRef: "test:full",
      byteLength: 42,
    };
    const stub: WorkingContextProjection = {
      kind: "working_set",
      renderMode: "stub",
      content: "<agenr_work_context>\nReason: missing_active_set\n</agenr_work_context>",
      sourceRef: "test:stub",
      byteLength: 40,
    };

    expect(shouldInjectWorkingContext(full)).toBe(true);
    expect(shouldInjectWorkingContext(stub)).toBe(false);
    expect(shouldInjectWorkingContext({ ...full, content: "   " })).toBe(false);
  });
});

describe("toWorkingContextAuditPointer", () => {
  it("returns a compact audit pointer for full projections", () => {
    expect(
      toWorkingContextAuditPointer({
        kind: "working_set",
        renderMode: "full",
        content: "<agenr_work_context></agenr_work_context>",
        workingSetId: "ws-1",
        revision: 3,
        sourceRef: "skeln:before-turn:key",
        byteLength: 32,
      }),
    ).toEqual({
      source: "agenr_work",
      workingSetId: "ws-1",
      revision: 3,
      sourceRef: "skeln:before-turn:key",
      bytes: 32,
      summary: "Working set ws-1 rev 3",
    });
  });

  it("returns undefined when provenance is incomplete", () => {
    expect(
      toWorkingContextAuditPointer({
        kind: "working_set",
        renderMode: "stub",
        content: "stub",
        sourceRef: "test:stub",
        byteLength: 4,
      }),
    ).toBeUndefined();
  });
});
