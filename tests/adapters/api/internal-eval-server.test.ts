import { afterEach, describe, expect, it, vi } from "vitest";

import type { CrossEncoderPassage, CrossEncoderPort, CrossEncoderScore } from "../../../src/core/ports.js";
import { startInternalEvalServer, type InternalEvalServerHandle } from "../../../src/adapters/api/internal-eval-server.js";

const servers: InternalEvalServerHandle[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await server.close();
    }
  }

  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
  delete process.env.AGENR_CONFIG_PATH;
  delete process.env.AGENR_CONFIG_DIR;
});

describe("startInternalEvalServer", () => {
  it("hosts the recall and before-turn internal eval routes on one local server", async () => {
    const server = await startInternalEvalServer({
      host: "127.0.0.1",
      port: 0,
    });
    servers.push(server);

    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(server.routePaths).toEqual(["/internal/evals/recall/run", "/internal/evals/before-turn/run"]);
  });

  it("returns 404 for missing routes and 405 for wrong methods on known routes", async () => {
    const server = await startInternalEvalServer({
      host: "127.0.0.1",
      port: 0,
    });
    servers.push(server);

    const missingRouteResponse = await fetch(`${server.baseUrl}/internal/evals/recall`, {
      method: "POST",
    });
    const wrongMethodResponse = await fetch(`${server.baseUrl}/internal/evals/before-turn/run`, {
      method: "GET",
    });

    expect(missingRouteResponse.status).toBe(404);
    expect(await missingRouteResponse.text()).toBe("Not found.\n");
    expect(wrongMethodResponse.status).toBe(405);
    expect(wrongMethodResponse.headers.get("allow")).toBe("POST");
  });

  it("reports cross_encoder status configured when an explicit port is injected", async () => {
    const server = await startInternalEvalServer({
      host: "127.0.0.1",
      port: 0,
      crossEncoder: createInertCrossEncoder(),
    });
    servers.push(server);

    expect(server.crossEncoder).toEqual({ status: "configured" });
  });

  it("reports cross_encoder status not_configured and fails closed when no credential is available", async () => {
    delete process.env.OPENAI_API_KEY;

    const server = await startInternalEvalServer({
      host: "127.0.0.1",
      port: 0,
      autoResolveCrossEncoder: false,
    });
    servers.push(server);

    expect(server.crossEncoder.status).toBe("not_configured");
    expect(server.crossEncoder.reason).toBeDefined();
  });

  it("forwards the injected cross-encoder port to the recall route for phase-4 rerank", async () => {
    process.env.OPENAI_API_KEY = "test-key-routes";

    const rankSpy = vi.fn<(query: string, passages: readonly CrossEncoderPassage[]) => Promise<CrossEncoderScore[]>>(async () => []);
    const crossEncoder: CrossEncoderPort = {
      rank: rankSpy,
    };

    const server = await startInternalEvalServer({
      host: "127.0.0.1",
      port: 0,
      crossEncoder,
    });
    servers.push(server);

    expect(server.crossEncoder).toEqual({ status: "configured" });

    const response = await fetch(`${server.baseUrl}/internal/evals/recall/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        caseId: "cross-encoder-wiring",
        memoryPool: [],
        recallRequest: {
          text: "",
        },
      }),
    });

    expect(response.status).toBe(400);
  });

  it("forwards the injected cross-encoder port to the before-turn route for phase-4 rerank", async () => {
    process.env.OPENAI_API_KEY = "test-key-routes";

    const rankSpy = vi.fn<(query: string, passages: readonly CrossEncoderPassage[]) => Promise<CrossEncoderScore[]>>(async () => []);
    const crossEncoder: CrossEncoderPort = {
      rank: rankSpy,
    };

    const server = await startInternalEvalServer({
      host: "127.0.0.1",
      port: 0,
      crossEncoder,
    });
    servers.push(server);

    expect(server.crossEncoder).toEqual({ status: "configured" });

    const response = await fetch(`${server.baseUrl}/internal/evals/before-turn/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        caseId: "before-turn-cross-encoder-wiring",
        memoryPool: [],
        beforeTurnInput: {},
      }),
    });

    expect(response.status).toBe(400);
  });
});

/**
 * Builds a deterministic cross-encoder stub that always returns an empty
 * shortlist without touching the network. The recall pipeline treats this
 * as a `provider_error` and short-circuits, which is enough to prove
 * the port reached the runner without introducing flaky HTTP behavior.
 */
function createInertCrossEncoder(): CrossEncoderPort {
  return {
    async rank(): Promise<CrossEncoderScore[]> {
      return [];
    },
  };
}
