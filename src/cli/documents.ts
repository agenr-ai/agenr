const MAX_PAGE_CHARS = 36_000;

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function stripHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function trimContent(text: string): string {
  if (text.length <= MAX_PAGE_CHARS) return text;
  return `${text.slice(0, MAX_PAGE_CHARS)}\n...[truncated]`;
}

async function fetchWithDefaultHeaders(url: string): Promise<Response> {
  return fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.8",
    },
  });
}

export async function fetchAsReadableText(url: string): Promise<string | null> {
  try {
    const normalized = url.startsWith("http://")
      ? url.replace(/^http:\/\//, "")
      : url.replace(/^https:\/\//, "");
    const readableResponse = await fetchWithDefaultHeaders(`https://r.jina.ai/http://${normalized}`);
    if (!readableResponse.ok) return null;

    const readable = await readableResponse.text();
    const cleaned = readable.replace(/\s+/g, " ").trim();
    return cleaned.length > 200 ? trimContent(cleaned) : null;
  } catch {
    return null;
  }
}
