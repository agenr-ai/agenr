type JsonHighlighterProps = {
  value: string;
  className?: string;
};

type JsonTokenType = "key" | "string" | "number" | "boolean" | "null" | "punctuation" | "text";

type JsonToken = {
  type: JsonTokenType;
  value: string;
};

const TOKEN_REGEX =
  /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b|[{}\[\],:]|\s+|./g;

const TOKEN_CLASS_BY_TYPE: Record<Exclude<JsonTokenType, "text">, string> = {
  key: "text-blue-700 dark:text-blue-300",
  string: "text-emerald-700 dark:text-emerald-300",
  number: "text-amber-700 dark:text-amber-300",
  boolean: "text-violet-700 dark:text-violet-300",
  null: "text-slate-500 dark:text-slate-400",
  punctuation: "text-app-text-muted",
};

function isValidJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function tokenizeJson(value: string): JsonToken[] {
  return Array.from(value.matchAll(TOKEN_REGEX), (match) => {
    const token = match[0];
    const tokenStart = match.index ?? 0;
    const tokenEnd = tokenStart + token.length;
    const nextNonWhitespace = value.slice(tokenEnd).match(/\S/)?.[0] ?? null;

    if (/^\s+$/.test(token)) {
      return { type: "text", value: token };
    }
    if (/^"(?:\\.|[^"\\])*"$/.test(token)) {
      if (nextNonWhitespace === ":") {
        return { type: "key", value: token };
      }
      return { type: "string", value: token };
    }
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
      return { type: "number", value: token };
    }
    if (token === "true" || token === "false") {
      return { type: "boolean", value: token };
    }
    if (token === "null") {
      return { type: "null", value: token };
    }
    if (/^[{}\[\],:]$/.test(token)) {
      return { type: "punctuation", value: token };
    }

    return { type: "text", value: token };
  });
}

export function JsonHighlighter({ value, className }: JsonHighlighterProps) {
  if (!isValidJson(value)) {
    return (
      <pre className={["font-mono text-sm text-app-text", className].filter(Boolean).join(" ")}>
        {value}
      </pre>
    );
  }

  const tokens = tokenizeJson(value);

  return (
    <pre className={["font-mono text-sm text-app-text", className].filter(Boolean).join(" ")}>
      {tokens.map((token, index) => {
        if (token.type === "text") {
          return <span key={`${index}-${token.value}`}>{token.value}</span>;
        }

        return (
          <span key={`${index}-${token.value}`} className={TOKEN_CLASS_BY_TYPE[token.type]}>
            {token.value}
          </span>
        );
      })}
    </pre>
  );
}
