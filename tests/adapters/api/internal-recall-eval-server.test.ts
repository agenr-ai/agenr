import { afterEach, describe, expect, it, vi } from "vitest";

import { startInternalRecallEvalServer, type InternalRecallEvalServerHandle } from "../../../src/adapters/api/internal-recall-eval-server.js";

const servers: InternalRecallEvalServerHandle[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await server.close();
    }
  }
});

describe("startInternalRecallEvalServer", () => {
  it("hosts the existing internal recall eval route on localhost", async () => {
    const runner = vi.fn(async (request) => ({
      status: "ok" as const,
      caseId: request.caseId,
      result: {
        entries: [],
        entryIds: [],
      },
    }));
    const server = await startInternalRecallEvalServer({
      host: "127.0.0.1",
      port: 0,
      runner,
    });
    servers.push(server);

    const response = await fetch(`${server.baseUrl}${server.routePath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        caseId: "server-case",
        memoryPool: [],
        recallRequest: {
          text: "who is on call",
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      caseId: "server-case",
      result: {
        entries: [],
        entryIds: [],
      },
    });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(server.routePath).toBe("/internal/evals/recall/run");
  });

  it("does not expose extra routes beyond the internal recall eval seam", async () => {
    const server = await startInternalRecallEvalServer({
      host: "127.0.0.1",
      port: 0,
      runner: async (request) => ({
        status: "ok",
        caseId: request.caseId,
        result: {
          entries: [],
          entryIds: [],
        },
      }),
    });
    servers.push(server);

    const missingRouteResponse = await fetch(`${server.baseUrl}/internal/evals/recall`, {
      method: "POST",
    });
    const wrongMethodResponse = await fetch(`${server.baseUrl}${server.routePath}`, {
      method: "GET",
    });

    expect(missingRouteResponse.status).toBe(404);
    expect(await missingRouteResponse.text()).toBe("Not found.\n");
    expect(wrongMethodResponse.status).toBe(405);
    expect(wrongMethodResponse.headers.get("allow")).toBe("POST");
  });
});
