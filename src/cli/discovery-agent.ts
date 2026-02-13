import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";

import type { AgenrConfig, ConfigOverrides, LlmProvider, SearchResult } from "./types";
import { resolveCredentials } from "./credentials";
import { fetchAsReadableText, stripHtml } from "./documents";
import { resolvePiAiModel } from "./pi-ai-client";
import { fetchAndParseOpenApiSpec, probeOpenApiPaths } from "./openapi";
import { searchBrave, searchDuckDuckGo } from "./web-search";
import { createEmptyFindings, type DiscoveryFindings, type DiscoveryResult } from "./discovery-types";

const DISCOVERY_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_PAGE_CHARS = 30_000;
const MAX_CONTEXT_FETCH_RESULTS = 3;
const OLD_PAGE_PREVIEW_CHARS = 500;
const HTML_THIN_CONTENT_THRESHOLD = 500;
const MAX_LINK_RESULTS = 50;
const ENDPOINT_BODY_CHARS = 2_000;
const DISCOVER_TIMEOUT_MS = 3_000;
const ENDPOINT_TIMEOUT_MS = 5_000;
const FETCH_PAGE_TIMEOUT_MS = 10_000;

const DEFAULT_BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/plain;q=0.8,*/*;q=0.7",
  "Accept-Language": "en-US,en;q=0.9",
};

const SOCIAL_DOMAINS = ["twitter.com", "x.com", "facebook.com", "linkedin.com"];
const RELEVANT_LINK_TERMS = ["api", "reference", "auth", "endpoint", "guide", "getting-started"];
const SAFE_ENDPOINT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const INTERESTING_ENDPOINT_HEADERS = new Set([
  "content-type",
  "www-authenticate",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "server",
  "location",
  "access-control-allow-origin",
]);



interface DiscoveryAgentOptions {
  platformName: string;
  docsUrl?: string;
  runtimeProvider: LlmProvider;
  runtimeModel: string;
  config: AgenrConfig;
  overrides: ConfigOverrides;
  writeThinking?: (text: string) => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown> | null, key: string): string {
  if (!record) return "";
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripInlineHtml(text: string): string {
  return decodeHtmlEntities(text.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function isJsonContentType(contentType: string): boolean {
  return contentType.includes("application/json") || contentType.includes("+json");
}

function isYamlContentType(contentType: string): boolean {
  return (
    contentType.includes("application/yaml") ||
    contentType.includes("application/x-yaml") ||
    contentType.includes("text/yaml") ||
    contentType.includes("text/x-yaml")
  );
}

function isHtmlContent(contentType: string, raw: string): boolean {
  return contentType.includes("text/html") || /<html[\s>]/i.test(raw);
}

function isPlainTextContentType(contentType: string): boolean {
  return contentType.includes("text/plain") || contentType.includes("text/markdown") || contentType.includes("text/");
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  return fetch(url, {
    ...init,
    signal,
  });
}

function normalizeUrlForDedup(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function isJunkLink(absoluteUrl: URL, rawHref: string): boolean {
  const href = rawHref.trim().toLowerCase();
  if (!href || href.startsWith("#") || href.startsWith("javascript:")) return true;

  const host = absoluteUrl.hostname.toLowerCase();
  if (SOCIAL_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return true;

  const target = `${absoluteUrl.pathname}${absoluteUrl.search}`.toLowerCase();
  if (
    target.includes("login") ||
    target.includes("sign-in") ||
    target.includes("signin") ||
    target.includes("signup") ||
    target.includes("sign-up")
  ) {
    return true;
  }

  return false;
}

function scoreDiscoveredLink(link: { text: string; url: string }): number {
  const haystack = `${link.text} ${link.url}`.toLowerCase();
  let score = 0;
  for (const term of RELEVANT_LINK_TERMS) {
    if (haystack.includes(term)) score += 2;
  }
  if (haystack.includes("openapi") || haystack.includes("swagger")) score += 2;
  if (haystack.includes("blog") || haystack.includes("careers")) score -= 2;
  return score;
}

function dedupeSearchResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];

  for (const result of results) {
    if (!result.url) continue;

    let key = result.url;
    try {
      const parsed = new URL(result.url);
      parsed.hash = "";
      key = parsed.toString();
    } catch {
      // Use raw URL when parsing fails.
    }

    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }

  return deduped;
}

function normalizeDomain(input: string): string {
  const value = input.trim();
  if (!value) {
    throw new Error("Domain cannot be empty.");
  }

  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    return parsed.host;
  } catch {
    return value.replace(/^https?:\/\//, "").split("/")[0] ?? value;
  }
}



function toolResultText(message: ToolResultMessage): string {
  return message.content
    .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
    .join("\n")
    .trim();
}

function toTextContent(text: string): TextContent[] {
  return [{ type: "text", text }];
}

function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
  return typeof message === "object" && message !== null && "role" in message && message.role === "toolResult";
}

function buildDiscoverySystemPrompt(platformName: string): string {
  return [
    "You are a developer researching a platform's API to build an integration.",
    `Your goal: find enough information to generate an AGP adapter for \"${platformName}\".`,
    "",
    "You need to discover:",
    "1. Authentication - How does the API authenticate? (OAuth, API key, JWT, cookie?)",
    "2. Base URLs - What are the API base URLs?",
    "3. Discovery endpoints - How to list available services/catalog/menu",
    "4. Query endpoints - How to search/filter/get details",
    "5. Execute endpoints - How to create orders/bookings/transactions",
    "6. Request/response shapes - What do the payloads look like?",
    "",
    "Research strategy (recommended order):",
    `1. Web search for "${platformName} API documentation" / "${platformName} developer docs"`,
    "2. From search results, identify the docs domain",
    "3. discover_subdomains on the base domain - find api.*, docs.*, developer.* subdomains",
    "4. check_openapi on all API-looking subdomains (best case: you find a spec and skip manual research)",
    "5. If no OpenAPI spec: extract_links on the main docs page -> follow auth, API reference, and getting-started links",
    "6. search_site to find specific topics within the docs domain",
    "7. search_github for SDKs/examples if docs are thin",
    "8. test_endpoint on discovered endpoints to verify they exist and check auth requirements",
    "9. save_finding as you go - don't wait until the end",
    "",
    "Prioritize:",
    "- OpenAPI specs (structured, complete) > SDK source code (real examples) > HTML docs (may be incomplete) > marketing pages (useless)",
    "- Auth discovery first - you can't use any endpoint without knowing the auth pattern",
    "- At least 2-3 endpoints per AGP operation (discover, query, execute) before stopping",
    "",
    "Efficiency tips:",
    "- When fetching pages or specs, request a large max_chars on the first try (40000+) to avoid re-fetching the same URL.",
    "- Don't re-fetch a URL you've already fetched at a smaller size. Use save_finding to capture what you need, then move on.",
    "",
    "Do not make up endpoints. If you cannot find documentation for an operation, note it as unsupported.",
    "",
    "Tool limits:",
  ].join("\n");
}

function buildDiscoveryPrompt(platformName: string, docsUrl?: string): string {
  const docsInstruction = docsUrl?.trim()
    ? ` If a --docs-url was provided, start there: ${docsUrl.trim()}`
    : "";
  return `Research the API documentation for ${platformName} and save your findings.${docsInstruction}`;
}

function pruneContext(messages: AgentMessage[], findings: DiscoveryFindings): AgentMessage[] {
  const fetchResultIndexes: number[] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!isToolResultMessage(message)) continue;
    if (message.toolName === "fetch_page") {
      fetchResultIndexes.push(index);
    }
  }

  const keepFullFetchIndexes = new Set(fetchResultIndexes.slice(-MAX_CONTEXT_FETCH_RESULTS));
  const findingCount = Object.values(findings).reduce((count, entries) => count + entries.length, 0);

  return messages.map((message, index) => {
    if (!isToolResultMessage(message) || message.toolName !== "fetch_page") {
      return message;
    }

    if (keepFullFetchIndexes.has(index)) {
      return message;
    }

    const detailsRecord = asRecord(message.details);
    const url = readString(detailsRecord, "url") || "unknown";
    const preview = toolResultText(message).replace(/\s+/g, " ").slice(0, OLD_PAGE_PREVIEW_CHARS);
    const summary = [
      "[fetch_page content pruned to manage context size]",
      `URL: ${url}`,
      `Preview: ${preview || "[no text extracted]"}`,
      findingCount > 0 ? "Use saved findings for durable facts." : "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      ...message,
      content: toTextContent(summary),
    };
  });
}

function formatToolArgs(args: unknown): string {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

const webSearchParamsSchema = Type.Object({
  query: Type.String({ description: "Search query" }),
});
type WebSearchParams = Static<typeof webSearchParamsSchema>;

const searchSiteParamsSchema = Type.Object({
  domain: Type.String({ description: "Domain to search within, e.g. docs.example.com" }),
  query: Type.String({ description: "Search query (site: prefix is added automatically)" }),
});
type SearchSiteParams = Static<typeof searchSiteParamsSchema>;

const searchGithubParamsSchema = Type.Object({
  query: Type.String({ description: "Search query for GitHub SDKs/examples" }),
});
type SearchGithubParams = Static<typeof searchGithubParamsSchema>;

const fetchPageParamsSchema = Type.Object({
  url: Type.String({ description: "URL to fetch" }),
  max_chars: Type.Optional(Type.Number({ description: "Max chars to return" })),
});
type FetchPageParams = Static<typeof fetchPageParamsSchema>;

const extractLinksParamsSchema = Type.Object({
  url: Type.String({ description: "URL to extract links from" }),
  filter: Type.Optional(
    Type.String({
      description: "Optional keyword filter. Matches link text or URL (case-insensitive).",
    }),
  ),
});
type ExtractLinksParams = Static<typeof extractLinksParamsSchema>;

const testEndpointParamsSchema = Type.Object({
  url: Type.String({ description: "Full endpoint URL to probe" }),
  method: Type.Optional(
    Type.Union([Type.Literal("GET"), Type.Literal("HEAD"), Type.Literal("OPTIONS")], {
      description: "HTTP method (default: GET). Only safe methods allowed.",
    }),
  ),
});
type TestEndpointParams = Static<typeof testEndpointParamsSchema>;

const discoverSubdomainsParamsSchema = Type.Object({
  domain: Type.String({ description: "Base domain to probe, e.g. example.com" }),
});
type DiscoverSubdomainsParams = Static<typeof discoverSubdomainsParamsSchema>;

const checkOpenApiParamsSchema = Type.Object({
  domain: Type.String({ description: "Domain to check, e.g. api.example.com" }),
});
type CheckOpenApiParams = Static<typeof checkOpenApiParamsSchema>;

const parseOpenApiParamsSchema = Type.Object({
  url: Type.String({ description: "URL to OpenAPI spec" }),
});
type ParseOpenApiParams = Static<typeof parseOpenApiParamsSchema>;

const saveFindingParamsSchema = Type.Object({
  category: Type.String({ description: "Category for this finding (e.g. auth, endpoints, base_urls, schemas, notes, or any relevant label)" }),
  content: Type.String({ description: "The finding" }),
  source_url: Type.Optional(Type.String({ description: "URL where this was found" })),
});
type SaveFindingParams = Static<typeof saveFindingParamsSchema>;

export async function runDiscoveryAgent(options: DiscoveryAgentOptions): Promise<DiscoveryResult> {
  const findings = createEmptyFindings();
  const sourceUrls = new Set<string>();
  let pagesVisited = 0;
  let toolCalls = 0;

  const registerToolCall = (): void => {
    toolCalls += 1;
  };

  const registerSourceUrl = (url: string | undefined | null): void => {
    const trimmed = url?.trim();
    if (!trimmed) return;
    sourceUrls.add(normalizeUrlForDedup(trimmed));
  };

  const registerSourceUrlsFromResults = (results: SearchResult[]): void => {
    for (const result of results) {
      registerSourceUrl(result.url);
    }
  };

  registerSourceUrl(options.docsUrl);

  const runSearchQuery = async (query: string): Promise<SearchResult[]> => {
    const braveResults = await searchBrave(query, 8);
    const fallbackResults = braveResults.length > 0 ? [] : await searchDuckDuckGo(query, 8);
    return dedupeSearchResults([...braveResults, ...fallbackResults]).slice(0, 8);
  };

  const searchTool: AgentTool<typeof webSearchParamsSchema> = {
    name: "web_search",
    label: "Web Search",
    description: "Search the web for API documentation, developer docs, or OpenAPI specs.",
    parameters: webSearchParamsSchema,
    execute: async (_toolCallId, params: WebSearchParams) => {
      registerToolCall();

      const query = params.query.trim();
      if (!query) {
        throw new Error("web_search query cannot be empty.");
      }

      const results = await runSearchQuery(query);
      registerSourceUrlsFromResults(results);

      return {
        content: toTextContent(JSON.stringify(results, null, 2)),
        details: {
          query,
          resultCount: results.length,
        },
      };
    },
  };

  const searchSiteTool: AgentTool<typeof searchSiteParamsSchema> = {
    name: "search_site",
    label: "Search Site",
    description: "Search within a known domain using site: scoping.",
    parameters: searchSiteParamsSchema,
    execute: async (_toolCallId, params: SearchSiteParams) => {
      registerToolCall();

      const domain = normalizeDomain(params.domain);
      const query = params.query.trim();
      if (!query) {
        throw new Error("search_site query cannot be empty.");
      }

      const scopedQuery = `site:${domain} ${query}`;
      const results = await runSearchQuery(scopedQuery);
      registerSourceUrlsFromResults(results);

      return {
        content: toTextContent(JSON.stringify(results, null, 2)),
        details: {
          domain,
          query,
          resultCount: results.length,
        },
      };
    },
  };

  const searchGithubTool: AgentTool<typeof searchGithubParamsSchema> = {
    name: "search_github",
    label: "Search GitHub",
    description: "Search GitHub for SDKs and integration examples.",
    parameters: searchGithubParamsSchema,
    execute: async (_toolCallId, params: SearchGithubParams) => {
      registerToolCall();

      const query = params.query.trim();
      if (!query) {
        throw new Error("search_github query cannot be empty.");
      }

      const scopedQuery = `site:github.com ${query}`;
      const results = await runSearchQuery(scopedQuery);
      registerSourceUrlsFromResults(results);

      return {
        content: toTextContent(JSON.stringify(results, null, 2)),
        details: {
          query,
          resultCount: results.length,
        },
      };
    },
  };

  const fetchPageTool: AgentTool<typeof fetchPageParamsSchema> = {
    name: "fetch_page",
    label: "Fetch Page",
    description: "Fetch a web page and extract readable text.",
    parameters: fetchPageParamsSchema,
    execute: async (_toolCallId, params: FetchPageParams) => {
      registerToolCall();

      const url = params.url.trim();
      if (!url) {
        throw new Error("fetch_page url cannot be empty.");
      }
      registerSourceUrl(url);

      const maxChars =
        typeof params.max_chars === "number" && Number.isFinite(params.max_chars) && params.max_chars > 0
          ? Math.floor(params.max_chars)
          : DEFAULT_PAGE_CHARS;

      let extracted = "";
      let contentType = "";
      let source: "direct" | "jina_fallback" = "direct";

      try {
        const response = await fetchWithTimeout(
          url,
          {
            redirect: "follow",
            headers: DEFAULT_BROWSER_HEADERS,
          },
          FETCH_PAGE_TIMEOUT_MS,
        );

        contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        const raw = await response.text();

        if (isJsonContentType(contentType)) {
          try {
            extracted = JSON.stringify(JSON.parse(raw), null, 2);
          } catch {
            extracted = raw;
          }
        } else if (isYamlContentType(contentType)) {
          extracted = raw;
        } else if (isHtmlContent(contentType, raw)) {
          const stripped = stripHtml(raw);
          if (stripped.length < HTML_THIN_CONTENT_THRESHOLD) {
            const readable = await fetchAsReadableText(url);
            if (readable) {
              extracted = readable;
              source = "jina_fallback";
            } else {
              extracted = stripped;
            }
          } else {
            extracted = stripped;
          }
        } else if (isPlainTextContentType(contentType)) {
          extracted = raw;
        } else {
          extracted = raw;
        }
      } catch (error) {
        const fallback = await fetchAsReadableText(url);
        if (!fallback) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to fetch page '${url}' directly and via Jina fallback: ${detail}`);
        }
        extracted = fallback;
        source = "jina_fallback";
      }

      if (!extracted.trim()) {
        throw new Error(`No content extracted from '${url}'.`);
      }

      pagesVisited += 1;

      return {
        content: toTextContent(truncate(extracted, maxChars)),
        details: {
          url,
          chars: Math.min(extracted.length, maxChars),
          source,
          contentType: contentType || "unknown",
        },
      };
    },
  };

  const extractLinksTool: AgentTool<typeof extractLinksParamsSchema> = {
    name: "extract_links",
    label: "Extract Links",
    description: "Extract links from a page to navigate docs by URL and link text.",
    parameters: extractLinksParamsSchema,
    execute: async (_toolCallId, params: ExtractLinksParams) => {
      registerToolCall();

      const url = params.url.trim();
      if (!url) {
        throw new Error("extract_links url cannot be empty.");
      }
      registerSourceUrl(url);

      const response = await fetchWithTimeout(
        url,
        {
          redirect: "follow",
          headers: DEFAULT_BROWSER_HEADERS,
        },
        FETCH_PAGE_TIMEOUT_MS,
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch '${url}' for link extraction (${response.status} ${response.statusText}).`);
      }

      const html = await response.text();
      const filter = params.filter?.trim().toLowerCase() ?? "";
      const seen = new Set<string>();
      const extractedLinks: Array<{ text: string; url: string }> = [];
      const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))[^>]*>([\s\S]*?)<\/a>/gi;

      let match: RegExpExecArray | null;
      while ((match = anchorPattern.exec(html)) !== null) {
        const href = (match[1] ?? match[2] ?? match[3] ?? "").trim();
        if (!href) continue;

        let absoluteUrl: URL;
        try {
          absoluteUrl = new URL(href, url);
        } catch {
          continue;
        }

        if (!["http:", "https:"].includes(absoluteUrl.protocol)) continue;
        if (isJunkLink(absoluteUrl, href)) continue;

        const normalizedUrl = normalizeUrlForDedup(absoluteUrl.toString());
        if (seen.has(normalizedUrl)) continue;

        const text = stripInlineHtml(match[4] ?? "");
        const candidate = {
          text: text || absoluteUrl.pathname || absoluteUrl.hostname,
          url: absoluteUrl.toString(),
        };

        if (filter && !`${candidate.text} ${candidate.url}`.toLowerCase().includes(filter)) continue;

        seen.add(normalizedUrl);
        extractedLinks.push(candidate);
      }

      const sorted = extractedLinks
        .sort((a, b) => {
          const scoreDelta = scoreDiscoveredLink(b) - scoreDiscoveredLink(a);
          if (scoreDelta !== 0) return scoreDelta;
          return a.url.localeCompare(b.url);
        })
        .slice(0, MAX_LINK_RESULTS);
      for (const link of sorted) {
        registerSourceUrl(link.url);
      }

      return {
        content: toTextContent(JSON.stringify(sorted, null, 2)),
        details: {
          url,
          filter: params.filter?.trim() || undefined,
          resultCount: sorted.length,
        },
      };
    },
  };

  const testEndpointTool: AgentTool<typeof testEndpointParamsSchema> = {
    name: "test_endpoint",
    label: "Test Endpoint",
    description: "Probe an endpoint with a safe HTTP method to verify status/auth behavior.",
    parameters: testEndpointParamsSchema,
    execute: async (_toolCallId, params: TestEndpointParams) => {
      registerToolCall();

      const url = params.url.trim();
      if (!url) {
        throw new Error("test_endpoint url cannot be empty.");
      }
      registerSourceUrl(url);

      const method = (params.method ?? "GET").toUpperCase();
      if (!SAFE_ENDPOINT_METHODS.has(method)) {
        throw new Error(`test_endpoint only allows GET, HEAD, or OPTIONS (received '${method}').`);
      }

      let response: Response;
      try {
        response = await fetchWithTimeout(
          url,
          {
            method,
            redirect: "manual",
            headers: {
              Accept: "*/*",
              "User-Agent": DEFAULT_BROWSER_HEADERS["User-Agent"],
            },
          },
          ENDPOINT_TIMEOUT_MS,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Network error while probing '${url}' with ${method}: ${detail}`);
      }

      const headers: Record<string, string> = {};
      for (const headerName of INTERESTING_ENDPOINT_HEADERS) {
        const value = response.headers.get(headerName);
        if (value) headers[headerName] = value;
      }

      let body = "";
      if (method !== "HEAD") {
        body = await response.text();
      }
      if (body.length > ENDPOINT_BODY_CHARS) {
        body = `${body.slice(0, ENDPOINT_BODY_CHARS)}\n...[truncated]`;
      }

      const payload = {
        status: response.status,
        statusText: response.statusText,
        headers,
        body,
      };

      return {
        content: toTextContent(JSON.stringify(payload, null, 2)),
        details: {
          url,
          method,
          status: response.status,
        },
      };
    },
  };

  const discoverSubdomainsTool: AgentTool<typeof discoverSubdomainsParamsSchema> = {
    name: "discover_subdomains",
    label: "Discover Subdomains",
    description: "Probe common API/docs subdomains and common docs paths on the base domain.",
    parameters: discoverSubdomainsParamsSchema,
    execute: async (_toolCallId, params: DiscoverSubdomainsParams) => {
      registerToolCall();

      const normalizedInput = normalizeDomain(params.domain).toLowerCase();
      const baseDomain = normalizedInput.split(":")[0] ?? normalizedInput;
      registerSourceUrl(`https://${baseDomain}`);
      const subdomainPrefixes = [
        "api",
        "developer",
        "developers",
        "dev",
        "docs",
        "doc",
        "sandbox",
        "partner",
        "open",
        "public-api",
      ];
      const basePaths = ["/developers", "/api", "/docs", "/api-docs"];

      const probe = async (subdomain: string, url: string) => {
        try {
          const response = await fetchWithTimeout(
            url,
            {
              method: "HEAD",
              redirect: "manual",
              headers: {
                "User-Agent": DEFAULT_BROWSER_HEADERS["User-Agent"],
              },
            },
            DISCOVER_TIMEOUT_MS,
          );

          const redirectsTo = response.headers.get("location") ?? undefined;
          return {
            subdomain,
            url,
            status: response.status,
            redirectsTo,
          };
        } catch {
          return null;
        }
      };

      const probes = [
        ...subdomainPrefixes.map((prefix) => {
          const subdomain = `${prefix}.${baseDomain}`;
          return probe(subdomain, `https://${subdomain}`);
        }),
        ...basePaths.map((path) => probe(baseDomain, `https://${baseDomain}${path}`)),
      ];

      const settled = await Promise.allSettled(probes);
      const seen = new Set<string>();
      const discovered: Array<{ subdomain: string; url: string; status: number; redirectsTo?: string }> = [];

      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        const probeResult = result.value;
        if (!probeResult) continue;
        const key = normalizeUrlForDedup(probeResult.url);
        if (seen.has(key)) continue;
        seen.add(key);
        discovered.push(probeResult);
        registerSourceUrl(probeResult.url);
      }

      return {
        content: toTextContent(JSON.stringify(discovered, null, 2)),
        details: {
          domain: baseDomain,
          resultCount: discovered.length,
        },
      };
    },
  };

  const checkOpenApiTool: AgentTool<typeof checkOpenApiParamsSchema> = {
    name: "check_openapi",
    label: "Check OpenAPI",
    description: "Probe a domain for OpenAPI/Swagger specs at well-known paths.",
    parameters: checkOpenApiParamsSchema,
    execute: async (_toolCallId, params: CheckOpenApiParams) => {
      registerToolCall();

      const domain = normalizeDomain(params.domain);
      registerSourceUrl(`https://${domain}`);
      const paths = await probeOpenApiPaths(domain);
      for (const specUrl of paths) {
        registerSourceUrl(specUrl);
      }

      return {
        content: toTextContent(paths.length > 0 ? JSON.stringify(paths, null, 2) : "No specs found"),
        details: {
          domain,
          found: paths.length,
        },
      };
    },
  };

  const parseOpenApiTool: AgentTool<typeof parseOpenApiParamsSchema> = {
    name: "parse_openapi",
    label: "Parse OpenAPI",
    description: "Download and parse an OpenAPI/Swagger spec.",
    parameters: parseOpenApiParamsSchema,
    execute: async (_toolCallId, params: ParseOpenApiParams) => {
      registerToolCall();

      const url = params.url.trim();
      if (!url) {
        throw new Error("parse_openapi url cannot be empty.");
      }
      registerSourceUrl(url);

      const summary = await fetchAndParseOpenApiSpec(url);

      return {
        content: toTextContent(JSON.stringify(summary, null, 2)),
        details: {
          url,
        },
      };
    },
  };

  const saveFindingTool: AgentTool<typeof saveFindingParamsSchema> = {
    name: "save_finding",
    label: "Save Finding",
    description: "Save a structured finding from your research.",
    parameters: saveFindingParamsSchema,
    execute: async (_toolCallId, params: SaveFindingParams) => {
      registerToolCall();

      const content = params.content.trim();
      if (!content) {
        throw new Error("save_finding content cannot be empty.");
      }

      const sourceUrl = params.source_url?.trim();
      registerSourceUrl(sourceUrl);
      const savedContent = sourceUrl ? `${content} (source: ${sourceUrl})` : content;

      const cat = params.category.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
      if (!findings[cat]) findings[cat] = [];
      if (!findings[cat].includes(savedContent)) {
        findings[cat].push(savedContent);
      }

      return {
        content: toTextContent(`Saved to ${params.category}`),
        details: {
          category: cat,
          ...(sourceUrl ? { source_url: sourceUrl } : {}),
          total: findings[cat].length,
        },
      };
    },
  };

  const model = resolvePiAiModel(options.runtimeProvider, options.runtimeModel);
  const agent = new Agent({
    initialState: {
      model,
      systemPrompt: buildDiscoverySystemPrompt(options.platformName),
      tools: [
        searchTool,
        searchSiteTool,
        searchGithubTool,
        fetchPageTool,
        extractLinksTool,
        testEndpointTool,
        discoverSubdomainsTool,
        checkOpenApiTool,
        parseOpenApiTool,
        saveFindingTool,
      ],
      thinkingLevel: "medium",
    },
    transformContext: async (messages) => pruneContext(messages, findings),
    getApiKey: async () => {
      const credentials = await resolveCredentials(options.config, options.overrides.provider);
      return credentials.token;
    },
  });

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "thinking_delta") {
        options.writeThinking?.(event.assistantMessageEvent.delta);
      }

      return;
    }

    if (event.type === "tool_execution_start") {
      const argsText = formatToolArgs(event.args);

      if (event.toolName === "save_finding") {
        const args = asRecord(event.args);
        const category = readString(args, "category") || "unknown";
        const content = readString(args, "content").replace(/\s+/g, " ");
        const summary = truncate(content, 120).replace(/\n/g, " ");
        process.stderr.write(`[save] ${category} - ${summary}\n`);
      } else if (event.toolName === "web_search" || event.toolName === "search_site" || event.toolName === "search_github") {
        process.stderr.write(`[search] ${event.toolName}: ${argsText}\n`);
      } else if (event.toolName === "extract_links") {
        process.stderr.write(`[links] ${argsText}\n`);
      } else if (event.toolName === "test_endpoint") {
        process.stderr.write(`[probe] ${argsText}\n`);
      } else if (event.toolName === "discover_subdomains") {
        process.stderr.write(`[dns] ${argsText}\n`);
      } else if (event.toolName === "check_openapi" || event.toolName === "parse_openapi") {
        process.stderr.write(`[openapi] ${event.toolName}: ${argsText}\n`);
      } else if (event.toolName === "fetch_page") {
        process.stderr.write(`[fetch] ${argsText}\n`);
      } else {
        process.stderr.write(`[tool] ${event.toolName}: ${argsText}\n`);
      }
      return;
    }

    if (event.type === "tool_execution_end") {
      const status = event.isError ? "FAILED" : "ok";
      process.stderr.write(`   ${status}\n`);
    }
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, DISCOVERY_TIMEOUT_MS);

  try {
    await agent.prompt(buildDiscoveryPrompt(options.platformName, options.docsUrl));
  } finally {
    clearTimeout(timeout);
    unsubscribe();
  }

  if (timedOut) {
    const timeoutNote = `Discovery timed out after ${DISCOVERY_TIMEOUT_MS / 1000} seconds; findings may be incomplete.`;
    if (!findings.notes.includes(timeoutNote)) {
      findings.notes.push(timeoutNote);
    }
    process.stderr.write(`[warn] ${timeoutNote}\n`);
  } else if (agent.state.error) {
    throw new Error(agent.state.error);
  }

  return {
    findings,
    pagesVisited,
    toolCalls,
    sourceUrls: Array.from(sourceUrls).sort((a, b) => a.localeCompare(b)),
  };
}
