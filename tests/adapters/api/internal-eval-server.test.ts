import { afterEach, describe, expect, it } from "vitest";

import { startInternalEvalServer, type InternalEvalServerHandle } from "../../../src/adapters/api/internal-eval-server.js";

const servers: InternalEvalServerHandle[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await server.close();
    }
  }
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
});
