import type { SearchResult } from "./types";

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeSearchUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("duckduckgo.com") && parsed.pathname.startsWith("/l/")) {
      const redirected = parsed.searchParams.get("uddg");
      if (redirected) return decodeURIComponent(redirected);
    }
  } catch {
    // Ignore parsing errors.
  }

  if (url.startsWith("/l/?")) {
    try {
      const parsed = new URL(`https://duckduckgo.com${url}`);
      const redirected = parsed.searchParams.get("uddg");
      if (redirected) return decodeURIComponent(redirected);
    } catch {
      // Ignore parsing errors.
    }
  }

  return url;
}

export async function searchBrave(query: string, limit: number): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_API_KEY?.trim();
  if (!apiKey) return [];

  const endpoint = new URL("https://api.search.brave.com/res/v1/web/search");
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("count", String(Math.max(limit, 5)));

  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    const detail = body.slice(0, 300).replace(/\s+/g, " ").trim();
    console.warn(
      `Warning: Brave search failed (${response.status} ${response.statusText}) for query '${query}'${
        detail ? `: ${detail}` : ""
      }`,
    );
    return [];
  }

  const payload = (await response.json()) as {
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
      }>;
    };
  };

  const results = payload.web?.results ?? [];
  return results
    .map((result) => ({
      title: result.title?.trim() || result.url?.trim() || "Untitled",
      url: result.url?.trim() ?? "",
      snippet: result.description?.trim() || undefined,
    }))
    .filter((result) => result.url.length > 0)
    .slice(0, limit);
}

export async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  const endpoint = new URL("https://duckduckgo.com/html/");
  endpoint.searchParams.set("q", query);

  const response = await fetch(endpoint, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) return [];

  const html = await response.text();
  const pattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

  const parsed: SearchResult[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null && parsed.length < limit) {
    const href = normalizeSearchUrl(match[1] ?? "").trim();
    const titleHtml = (match[2] ?? "").replace(/<[^>]+>/g, " ");
    const title = decodeHtmlEntities(titleHtml).replace(/\s+/g, " ").trim();

    if (!href.startsWith("http")) continue;

    parsed.push({
      title: title || href,
      url: href,
    });
  }

  return parsed;
}

function scoreResult(result: SearchResult): number {
  const haystack = `${result.title} ${result.url} ${result.snippet ?? ""}`.toLowerCase();

  let score = 0;
  if (haystack.includes("developer")) score += 3;
  if (haystack.includes("api")) score += 3;
  if (haystack.includes("docs")) score += 3;
  if (haystack.includes("reference")) score += 2;
  if (haystack.includes("graphql")) score += 1;
  if (haystack.includes("openapi")) score += 1;

  if (haystack.includes("github.com")) score -= 1;
  if (haystack.includes("stackoverflow")) score -= 1;

  return score;
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];

  for (const result of results) {
    try {
      const normalized = new URL(result.url);
      normalized.hash = "";
      const key = normalized.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(result);
    } catch {
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      deduped.push(result);
    }
  }

  return deduped;
}
