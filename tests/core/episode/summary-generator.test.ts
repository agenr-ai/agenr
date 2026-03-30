import { describe, expect, it, vi } from "vitest";

import { generateEpisodeSummary } from "../../../src/core/episode/summary-generator.js";
import { buildEpisodeSummaryPrompt, EPISODE_SUMMARY_SYSTEM_PROMPT, parseEpisodeSummaryResponse } from "../../../src/core/episode/summary-prompt.js";
import type { LlmPort } from "../../../src/core/ports.js";

describe("parseEpisodeSummaryResponse", () => {
  it("parses fenced JSON responses", () => {
    expect(
      parseEpisodeSummaryResponse(
        [
          "```json",
          JSON.stringify({
            summary: "We reviewed the ingest plan, narrowed the scope to Stage 2, and aligned on shared core summary generation plus a two-phase app service.",
            tags: ["ingest", "episodes", "planning"],
            activityLevel: "substantial",
            project: "agenr",
          }),
          "```",
        ].join("\n"),
      ),
    ).toEqual({
      summary: "We reviewed the ingest plan, narrowed the scope to Stage 2, and aligned on shared core summary generation plus a two-phase app service.",
      tags: ["ingest", "episodes", "planning"],
      activityLevel: "substantial",
      project: "agenr",
    });
  });

  it("parses wrapper text around the JSON object", () => {
    expect(
      parseEpisodeSummaryResponse(
        [
          "Here is the structured output you asked for:",
          JSON.stringify({
            summary:
              "The session focused on wiring shared episode summary generation into core and protecting the Stage 2 execution path from payload-hash churn.",
            tags: ["episodes", "core", "openclaw"],
            activityLevel: "minimal",
            project: null,
          }),
          "Done.",
        ].join("\n"),
      ),
    ).toEqual({
      summary: "The session focused on wiring shared episode summary generation into core and protecting the Stage 2 execution path from payload-hash churn.",
      tags: ["episodes", "core", "openclaw"],
      activityLevel: "minimal",
    });
  });

  it("returns null for invalid responses", () => {
    expect(parseEpisodeSummaryResponse('{"tags":["oops"]}')).toBeNull();
    expect(parseEpisodeSummaryResponse("not json")).toBeNull();
  });
});

describe("generateEpisodeSummary", () => {
  it("uses the shared prompt builder and parses the model response", async () => {
    const complete = vi.fn(async () =>
      JSON.stringify({
        summary:
          "We implemented the shared episode summary generator and confirmed the OpenClaw writer still produces structured summaries for predecessor sessions.",
        tags: ["episodes", "generator", "openclaw"],
        activityLevel: "substantial",
        project: "agenr",
      }),
    );
    const llm: LlmPort = {
      complete,
      completeJson: async <T>(): Promise<T> => ({}) as T,
    };

    const transcript = "User: Implement Stage 2.\nAssistant: Shared core summary generation is in.";
    const result = await generateEpisodeSummary(transcript, llm);

    expect(result).toEqual({
      summary:
        "We implemented the shared episode summary generator and confirmed the OpenClaw writer still produces structured summaries for predecessor sessions.",
      tags: ["episodes", "generator", "openclaw"],
      activityLevel: "substantial",
      project: "agenr",
    });
    expect(complete).toHaveBeenCalledWith(EPISODE_SUMMARY_SYSTEM_PROMPT, buildEpisodeSummaryPrompt(transcript));
  });
});
