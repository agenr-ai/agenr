import { describe, expect, it } from "vitest";

import type { DatabasePort, LlmPort } from "../../../src/core/ports.js";
import { extractClaimKey, getEntityHints } from "../../../src/core/store/claim-extraction.js";
import type { Entry } from "../../../src/core/types.js";

describe("extractClaimKey", () => {
  it("extracts a normalized claim key for an eligible fact entry", async () => {
    const llm = new MockLlmPort({
      entity: "Jim",
      attribute: "home city",
      confidence: 0.93,
    });

    const result = await extractClaimKey(
      {
        type: "fact",
        subject: "Jim's home city",
        content: "Jim lives in Denver, Colorado.",
      },
      [],
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision"],
      },
    );

    expect(result).toEqual({
      claimKey: "jim/home_city",
      confidence: 0.93,
      rawEntity: "Jim",
      rawAttribute: "home city",
    });
  });

  it("resolves self-references when exactly one entity hint exists", async () => {
    const llm = new MockLlmPort({
      entity: "the user",
      attribute: "timezone",
      confidence: 0.88,
    });

    const result = await extractClaimKey(
      {
        type: "fact",
        subject: "User timezone",
        content: "The user's timezone is America/Chicago.",
      },
      ["research_agent"],
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision"],
      },
    );

    expect(result?.claimKey).toBe("research_agent/timezone");
  });

  it("rejects unresolved self-referential entities when multiple hints make resolution ambiguous", async () => {
    const llm = new MockLlmPort({
      entity: "we",
      attribute: "deployment process",
      confidence: 0.88,
    });
    const warnings: string[] = [];

    const result = await extractClaimKey(
      {
        type: "decision",
        subject: "Deployment process",
        content: "We deploy with blue-green cutovers.",
      },
      ["platform_team", "deploy_pipeline"],
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision"],
      },
      {
        onWarning: (warning) => warnings.push(warning),
      },
    );

    expect(result).toBeNull();
    expect(warnings[0]).toMatch(/self-referential/i);
  });

  it("skips ineligible entry types", async () => {
    const llm = new MockLlmPort({
      entity: "Jim",
      attribute: "home city",
      confidence: 0.95,
    });

    await expect(
      extractClaimKey(
        {
          type: "milestone",
          subject: "Jim moved",
          content: "Jim moved to Denver.",
        },
        [],
        llm,
        {
          enabled: true,
          confidenceThreshold: 0.8,
          eligibleTypes: ["fact", "preference", "decision"],
        },
      ),
    ).resolves.toBeNull();
    expect(llm.calls).toEqual([]);
  });

  it("drops results below the configured confidence threshold", async () => {
    const llm = new MockLlmPort({
      entity: "Jim",
      attribute: "home city",
      confidence: 0.5,
    });

    await expect(
      extractClaimKey(
        {
          type: "fact",
          subject: "Jim's home city",
          content: "Jim lives in Denver, Colorado.",
        },
        [],
        llm,
        {
          enabled: true,
          confidenceThreshold: 0.8,
          eligibleTypes: ["fact", "preference", "decision"],
        },
      ),
    ).resolves.toBeNull();
  });

  it("rejects generic extracted attributes", async () => {
    const llm = new MockLlmPort({
      entity: "Project X",
      attribute: "details",
      confidence: 0.95,
    });
    const warnings: string[] = [];

    const result = await extractClaimKey(
      {
        type: "fact",
        subject: "Project X",
        content: "Project X uses blue-green deploys.",
      },
      [],
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision"],
      },
      {
        onWarning: (warning) => warnings.push(warning),
      },
    );

    expect(result).toBeNull();
    expect(warnings[0]).toMatch(/too generic/i);
  });

  it("rejects value-shaped extracted attributes", async () => {
    const llm = new MockLlmPort({
      entity: "React Router",
      attribute: "v7",
      confidence: 0.95,
    });
    const warnings: string[] = [];

    const result = await extractClaimKey(
      {
        type: "fact",
        subject: "React Router version",
        content: "The project currently uses React Router v7.",
      },
      [],
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision"],
      },
      {
        onWarning: (warning) => warnings.push(warning),
      },
    );

    expect(result).toBeNull();
    expect(warnings[0]).toMatch(/value-shaped/i);
  });
});

describe("getEntityHints", () => {
  it("returns distinct entity prefixes from the database port", async () => {
    const db = new MockDatabasePort(["jim", "agenr"]);

    await expect(getEntityHints(db)).resolves.toEqual(["jim", "agenr"]);
  });
});

class MockLlmPort implements LlmPort {
  public readonly calls: Array<{ systemPrompt: string; userMessage: string }> = [];

  public constructor(private readonly response: Record<string, unknown>) {}

  public async complete(): Promise<string> {
    throw new Error("complete() is not used in these tests.");
  }

  public async completeJson<T>(systemPrompt: string, userMessage: string): Promise<T> {
    this.calls.push({ systemPrompt, userMessage });
    return this.response as T;
  }
}

class MockDatabasePort implements DatabasePort {
  public constructor(private readonly claimKeyPrefixes: string[]) {}

  public async insertEntry(): Promise<string> {
    throw new Error("insertEntry() is not used in these tests.");
  }

  public async prepareForBulkWrites(): Promise<void> {}

  public async finalizeBulkWrites(): Promise<void> {}

  public async getEntries(): Promise<Entry[]> {
    return [];
  }

  public async getEntry(): Promise<Entry | null> {
    return null;
  }

  public async findExistingHashes(): Promise<Set<string>> {
    return new Set();
  }

  public async findExistingNormHashes(): Promise<Set<string>> {
    return new Set();
  }

  public async retireEntry(): Promise<boolean> {
    return false;
  }

  public async supersedeEntry(): Promise<boolean> {
    return false;
  }

  public async findActiveEntriesByClaimKey(): Promise<Entry[]> {
    return [];
  }

  public async getDistinctClaimKeyPrefixes(): Promise<string[]> {
    return this.claimKeyPrefixes;
  }

  public async updateEntry(): Promise<boolean> {
    return false;
  }

  public async getIngestLogEntry(): Promise<{ fileHash: string; ingestedAt: string } | null> {
    return null;
  }

  public async insertIngestLogEntry(): Promise<void> {}

  public async init(): Promise<void> {}

  public async close(): Promise<void> {}
}
