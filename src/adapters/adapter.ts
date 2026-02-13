import type { AdapterContext } from "./context";

export type { AdapterManifest, AuthStrategy } from "./manifest";
export { defineManifest } from "./manifest";

export interface ExecuteOptions {
  idempotencyKey?: string;
}

export interface AgpAdapter {
  discover(ctx: AdapterContext): Promise<unknown>;
  query(request: Record<string, unknown>, ctx: AdapterContext): Promise<unknown>;
  execute(
    request: Record<string, unknown>,
    options: ExecuteOptions | undefined,
    ctx: AdapterContext,
  ): Promise<unknown>;
  testExecuteParams?(): Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
}
