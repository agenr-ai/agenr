import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAgenrOpenClawServices } from "../../../src/adapters/openclaw/runtime.js";
import type { AgenrOpenClawHost } from "../../../src/adapters/openclaw/types.js";

const tempRoots: string[] = [];

describe("createAgenrOpenClawServices", () => {
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();

    while (tempRoots.length > 0) {
      await rm(tempRoots.pop() ?? "", { force: true, recursive: true });
    }

    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }
  });

  it("loads embedding credentials from agenr config next to dbPath", async () => {
    const root = await createTempRoot();
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      apiKey: "config-key",
      embeddingModel: "text-embedding-from-config",
    });

    const requestBodies: Array<{ model: string; input: string[] }> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as { model: string; input: string[] });

      return new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [1, 2, 3] }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const services = await createAgenrOpenClawServices(
      { dbPath },
      {
        openClaw: createOpenClawHost(),
      },
    );

    expect(services.embeddingStatus).toMatchObject({
      available: true,
      provider: "openai",
      model: "text-embedding-from-config",
    });
    await expect(services.embedding.embed(["remember this"])).resolves.toEqual([[1, 2, 3]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer config-key",
    });
    expect(requestBodies).toMatchObject([
      {
        input: ["remember this"],
        model: "text-embedding-from-config",
      },
    ]);

    await services.close();
  });

  it("uses configPath when the config file is not adjacent to dbPath", async () => {
    const root = await createTempRoot();
    const dbPath = path.join(root, "data", "knowledge.db");
    const configPath = path.join(root, "settings", "agenr.json");
    await writeJson(configPath, {
      embeddingApiKey: "explicit-config-key",
      embeddingModel: "text-embedding-explicit",
    });

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [4, 5, 6] }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const services = await createAgenrOpenClawServices(
      {
        dbPath,
        configPath,
      },
      {
        openClaw: createOpenClawHost(),
      },
    );

    expect(services.embeddingStatus).toMatchObject({
      available: true,
      model: "text-embedding-explicit",
    });
    await expect(services.embedding.embed(["override path"])).resolves.toEqual([[4, 5, 6]]);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer explicit-config-key",
    });

    await services.close();
  });
});

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-runtime-"));
  tempRoots.push(root);
  return root;
}

async function writeJson(filePath: string, value: object): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2));
}

function createOpenClawHost(): AgenrOpenClawHost {
  const workspaceDir = path.join(os.tmpdir(), "agenr-openclaw-test-workspace");
  const agentDir = path.join(os.tmpdir(), "agenr-openclaw-test-agent");
  const config = {
    defaultAgent: "main",
    agents: {
      list: [
        {
          id: "main",
          workspace: workspaceDir,
          agentDir,
          model: "openai/gpt-5.4-mini",
        },
      ],
    },
  } as unknown as OpenClawConfig;

  return {
    config,
    runtime: {
      agent: {
        resolveAgentDir: () => agentDir,
        resolveAgentWorkspaceDir: () => workspaceDir,
        runEmbeddedPiAgent: async () => {
          throw new Error("Embedded summary runner unavailable.");
        },
      },
      state: {
        resolveStateDir: () => path.join(os.tmpdir(), ".openclaw"),
      },
    },
  };
}
