export type AgenrVariables = {
  requestId: string;
  userId: string | undefined;
  apiKeyId: string | undefined;
  apiKeyTier: "free" | "paid" | "admin" | undefined;
  apiKeyScopes: string[] | undefined;
};

declare module "hono" {
  interface ContextVariableMap extends AgenrVariables {}
}
