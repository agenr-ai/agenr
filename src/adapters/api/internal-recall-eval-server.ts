import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { createInternalRecallEvalRoute, type InternalApiRoute, type RecallEvalCaseRunner } from "./routes/internal-recall-eval.js";

/**
 * Default loopback host for the internal recall eval dev server.
 */
const DEFAULT_INTERNAL_RECALL_EVAL_HOST = "127.0.0.1";

/**
 * Default port for the internal recall eval dev server.
 */
const DEFAULT_INTERNAL_RECALL_EVAL_PORT = 4010;

export { DEFAULT_INTERNAL_RECALL_EVAL_HOST, DEFAULT_INTERNAL_RECALL_EVAL_PORT };

/**
 * Startup options for the internal recall eval dev server.
 */
export interface InternalRecallEvalServerOptions {
  /** Host interface to bind. Defaults to loopback only. */
  host?: string;
  /** TCP port to bind. Defaults to the shared local eval port. */
  port?: number;
  /** Optional app-layer runner override used by tests. */
  runner?: RecallEvalCaseRunner;
}

/**
 * Live handle returned after the internal recall eval dev server starts.
 */
export interface InternalRecallEvalServerHandle {
  /** Bound host interface. */
  host: string;
  /** Bound TCP port. */
  port: number;
  /** Stable recall eval route path served by this host. */
  routePath: string;
  /** Base URL developers should point `agenr-evals` at. */
  baseUrl: string;
  /** Stops the HTTP server and releases the port. */
  close(): Promise<void>;
}

/**
 * Starts a tiny local-only HTTP server for the existing internal recall eval route.
 *
 * @param options - Optional bind settings and test runner override.
 * @returns Live server handle with the bound base URL and close helper.
 */
export async function startInternalRecallEvalServer(options: InternalRecallEvalServerOptions = {}): Promise<InternalRecallEvalServerHandle> {
  const host = options.host ?? DEFAULT_INTERNAL_RECALL_EVAL_HOST;
  const port = options.port ?? DEFAULT_INTERNAL_RECALL_EVAL_PORT;
  const route = createInternalRecallEvalRoute(options.runner);
  const server = createServer((request, response) => {
    void handleRequest(request, response, route, host, port).catch(() => {
      if (response.headersSent !== true) {
        writeTextResponse(response, 500, "Internal server error.\n");
        return;
      }

      response.destroy();
    });
  });

  await listen(server, port, host);

  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Internal recall eval server did not expose a TCP address.");
  }

  return {
    host,
    port: address.port,
    routePath: route.path,
    baseUrl: `http://${formatHostForUrl(host)}:${address.port}`,
    close: async (): Promise<void> => {
      await closeServer(server);
    },
  };
}

const handleRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  route: InternalApiRoute,
  fallbackHost: string,
  fallbackPort: number,
): Promise<void> => {
  const requestUrl = new URL(request.url ?? "/", `http://${formatHostForUrl(fallbackHost)}:${request.socket.localPort ?? fallbackPort}`);

  if (requestUrl.pathname !== route.path) {
    writeTextResponse(response, 404, "Not found.\n");
    return;
  }

  if (request.method !== route.method) {
    response.statusCode = 405;
    response.setHeader("allow", route.method);
    response.end();
    return;
  }

  const body = await readBody(request);
  const routeRequest = new Request(requestUrl, {
    method: route.method,
    headers: toHeaders(request),
    body: body.length > 0 ? body : undefined,
  });
  const routeResponse = await route.handler(routeRequest);
  await writeRouteResponse(response, routeResponse);
};

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
};

const toHeaders = (request: IncomingMessage): Headers => {
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
      continue;
    }

    headers.set(name, value);
  }

  return headers;
};

const writeRouteResponse = async (response: ServerResponse, routeResponse: Response): Promise<void> => {
  response.statusCode = routeResponse.status;

  for (const [name, value] of routeResponse.headers) {
    response.setHeader(name, value);
  }

  const body = Buffer.from(await routeResponse.arrayBuffer());
  response.end(body);
};

const writeTextResponse = (response: ServerResponse, status: number, body: string): void => {
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(body);
};

const listen = async (server: Server, port: number, host: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
};

const closeServer = async (server: Server): Promise<void> => {
  if (server.listening !== true) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
};

const formatHostForUrl = (host: string): string => {
  if (host.includes(":") && host.startsWith("[") !== true) {
    return `[${host}]`;
  }

  return host;
};
