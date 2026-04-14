import { afterEach, describe, expect, it, vi } from "vitest";

import type { InternalApiRoute } from "../../../src/adapters/api/internal-api-route.js";
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
  it("hosts the recall route on the shared internal eval server and preserves the compatibility handle", async () => {
    const recallRoute: InternalApiRoute = {
      method: "POST",
      path: "/internal/evals/recall/run",
      handler: vi.fn(
        async (request) =>
          new Response(
            JSON.stringify({
              status: "ok",
              caseId: ((await request.json()) as { caseId: string }).caseId,
              result: {
                entries: [],
                entryIds: [],
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json; charset=utf-8",
              },
            },
          ),
      ),
    };
    const beforeTurnRoute: InternalApiRoute = {
      method: "POST",
      path: "/internal/evals/before-turn/run",
      handler: async () =>
        new Response(
          JSON.stringify({
            status: "ok",
            caseId: "before-turn",
            output: {
              abstained: true,
              selectedEntryIds: [],
              selectedProcedureKey: null,
              patch: {
                durableMemory: [],
                diagnostics: {
                  recentTurnCount: 0,
                  durableRecallUsed: false,
                  durableRecallCandidateCount: 0,
                  procedureRecallUsed: false,
                  procedureCandidateCount: 0,
                  abstained: true,
                  abstentionReasons: [],
                  notices: [],
                },
              },
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
            },
          },
        ),
    };
    const server = await startInternalRecallEvalServer({
      host: "127.0.0.1",
      port: 0,
      routes: [recallRoute, beforeTurnRoute],
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
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(server.routePath).toBe("/internal/evals/recall/run");
    expect(server.routePaths).toEqual(["/internal/evals/recall/run", "/internal/evals/before-turn/run"]);
  });

  it("still serves 404 and 405 responses through the compatibility wrapper", async () => {
    const server = await startInternalRecallEvalServer({
      host: "127.0.0.1",
      port: 0,
      routes: [
        {
          method: "POST",
          path: "/internal/evals/recall/run",
          handler: async () => new Response(JSON.stringify({ status: "ok", caseId: "compat" }), { status: 200 }),
        },
        {
          method: "POST",
          path: "/internal/evals/before-turn/run",
          handler: async () => new Response(JSON.stringify({ status: "ok", caseId: "before-turn" }), { status: 200 }),
        },
      ],
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
