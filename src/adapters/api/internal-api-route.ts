/**
 * Minimal route definition shape for internal API handlers.
 */
export interface InternalApiRoute {
  /** Stable HTTP method for the route definition. */
  method: "POST";
  /** Stable path for the route definition. */
  path: string;
  /** Request handler implementing the route behavior. */
  handler(request: Request): Promise<Response>;
}
