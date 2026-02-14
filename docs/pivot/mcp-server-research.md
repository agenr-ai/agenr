# MCP Server Research Notes

## Current @agenr/mcp Package

Location: packages/mcp/src/ (2 files: index.ts, tools.ts)

### MCP SDK
- Uses @modelcontextprotocol/sdk ^1.12.0
- Imports McpServer from @modelcontextprotocol/sdk/server/mcp.js
- Imports StdioServerTransport from @modelcontextprotocol/sdk/server/stdio.js
- Already uses stdio transport

### How it registers tools
- Uses server.tool(name, description, inputSchema, handler) method
- Has a compatibility shim that tries registerTool() first, then tool()
- 4 tools registered: agenr_discover, agenr_query, agenr_execute, agenr_status

### How it connects to Agenr
- Uses @agenr/sdk (AgenrClient) -- makes HTTP calls to the Agenr API server
- Reads AGENR_API_KEY and AGENR_BASE_URL from environment
- This is a CLIENT approach: MCP server -> HTTP -> Agenr server -> adapter
- The pivot needs a DIRECT approach: MCP server -> adapter (no HTTP server)

### Tool shapes (current)
- discover: { businessId: string }
- query: { businessId: string, request: object }
- execute: { businessId: string, request: object }
- status: { transactionId: string }

## Adapter Registry (src/core/adapter-registry.ts)

### AdapterEntry shape
```
{
  platform: string           // e.g. "github", "dominos"
  ownerId?: string          // undefined for public adapters
  status: "public" | "sandbox"
  factory: AdapterFactory   // (business, ctx) => AgpAdapter
  source: string            // file path
  meta?: Record<string, unknown>  // includes name, etc.
  manifest?: AdapterManifest      // auth config, domains, etc.
}
```

### AdapterFactory type
```
(business: BusinessProfile, ctx: AdapterContext) => AgpAdapter
```

### How adapters are loaded
1. seedBundledAdapters() -- reads .ts files from data/adapters/ directory
2. loadDynamicAdapters() -- reads from DB + runtime adapters directory
3. hotLoadPublic(platform, filePath) -- dynamic import of .ts file
4. The .ts file must default-export a class with discover/query/execute methods
5. Bundled adapters dir: process.env.AGENR_BUNDLED_ADAPTERS_DIR or data/adapters/

### Getting an adapter instance
```
const entry = registry.resolveEntry(platform, ownerId?)
const adapter = entry.factory(business, ctx)
await adapter.discover(ctx)
await adapter.query(request, ctx)
await adapter.execute(request, options, ctx)
```

### Available bundled adapters
- dominos.ts
- echo.ts
- github.ts
- stripe.ts

## AgpAdapter Interface (src/adapters/adapter.ts)

```
interface AgpAdapter {
  discover(ctx: AdapterContext): Promise<unknown>
  query(request: Record<string, unknown>, ctx: AdapterContext): Promise<unknown>
  execute(request: Record<string, unknown>, options: ExecuteOptions | undefined, ctx: AdapterContext): Promise<unknown>
}
```

## AdapterContext (src/adapters/context.ts)

- Wraps credential resolution, authenticated fetch, auth header injection
- Constructor takes AdapterContextOptions:
  - platform, userId, executionId, manifest, abortSignal, resolveCredential
- resolveCredential is an async function that returns AuthCredential | null
- ctx.fetch(url, init) handles auth injection and 401 retry automatically

### AuthCredential shape
```
{
  token?: string        // OAuth access token
  apiKey?: string       // API key
  username?: string     // Basic auth
  password?: string
  cookieValue?: string
  headerValue?: string  // Generic header value
  clientId?: string
  clientSecret?: string
}
```

## AGP Service (src/core/agp-service.ts)

### Flow
- discover/query/execute all follow same pattern:
  1. Resolve business (from DB, profile store, or adapter registry)
  2. Create adapter + context (with credential resolution)
  3. Invoke adapter method with timeout
  4. Record transaction in TransactionStore
- Does NOT handle confirmation tokens itself -- that's adapter-level

### Credential resolution
- Uses vault/credential-store.ts retrieveCredential(userId, service)
- Supports OAuth token refresh via vault/token-refresh.ts
- Credential service is derived from manifest (oauth service or platform name)

### Key dependency: BusinessProfile
```
{
  id: string
  name: string
  platform: string
  location?: object
  preferences?: object
}
```
The new MCP server won't have businesses. Adapters ARE the targets.

## Design Decisions for New MCP Server

### Architecture
- MCP server loads adapters directly (like AdapterRegistry does)
- No HTTP server, no database, no transaction store
- Adapters are the first-class concept (not businesses)
- platform name = adapter name = the routing key

### Credential Management (v1)
- Environment variables with convention: AGENR_{PLATFORM}_TOKEN, etc.
- Simple: read env vars, construct AuthCredential
- Each adapter's manifest declares auth type, so we know what to look for
- Example: GitHub manifest says auth.type=api_key -> look for AGENR_GITHUB_TOKEN
- Example: Atlassian says auth.type=basic -> AGENR_ATLASSIAN_USERNAME + AGENR_ATLASSIAN_PASSWORD
- Dominos says auth.type=none -> no credentials needed

### What to reuse
- AdapterManifest type and defineManifest (from adapters/manifest.ts)
- AdapterContext class (from adapters/context.ts) -- need simplified version
- AgpAdapter interface (from adapters/adapter.ts)
- Adapter loading logic from AdapterRegistry (the hotLoad/import pattern)
- The existing .ts adapter files in data/adapters/

### What to NOT bring in
- Database (SQLite, libsql)
- ProfileStore, InteractionProfileStore, TransactionStore
- BusinessProfile concept
- Vault/credential-store (replace with env var lookup)
- OAuth token refresh (v2)
- The @agenr/sdk HTTP client

### Tool token budget
- discover (no args): ~200 tokens for list of 10 adapters
- discover (with adapter): full discover response (varies, but structured)
- query/execute: pass-through, size depends on adapter response
- Tool descriptions should be minimal (save tokens in tool listing)
