import { startInternalEvalServer, type InternalEvalServerOptions } from "./internal-eval-server.js";
import { INTERNAL_RECALL_EVAL_ROUTE_PATH } from "./routes/internal-recall-eval.js";

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
  /** Optional shared-route override used by tests. */
  routes?: InternalEvalServerOptions["routes"];
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
  /** Stable route paths served by this host. */
  routePaths: string[];
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
  const server = await startInternalEvalServer({
    host: options.host ?? DEFAULT_INTERNAL_RECALL_EVAL_HOST,
    port: options.port ?? DEFAULT_INTERNAL_RECALL_EVAL_PORT,
    routes: options.routes,
  });

  return {
    host: server.host,
    port: server.port,
    routePath: INTERNAL_RECALL_EVAL_ROUTE_PATH,
    routePaths: server.routePaths,
    baseUrl: server.baseUrl,
    close: server.close,
  };
}
