import { useEffect, useMemo, useState } from "react";

interface SourceModalProps {
  title: string;
  sourceCode: string;
  onClose: () => void;
}

type TokenType = "keyword" | "string" | "comment" | "number" | "type" | "default";
type InternalTokenType = TokenType | "identifier";

interface Token {
  text: string;
  type: TokenType;
}

interface InternalToken {
  text: string;
  type: InternalTokenType;
}

const KEYWORDS = new Set([
  "import",
  "export",
  "from",
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "class",
  "interface",
  "type",
  "async",
  "await",
  "new",
  "throw",
  "try",
  "catch",
  "typeof",
  "extends",
  "implements",
  "as",
  "default",
  "void",
  "null",
  "undefined",
  "true",
  "false",
]);

function isDigit(value: string): boolean {
  return value >= "0" && value <= "9";
}

function isIdentifierStart(value: string): boolean {
  return /[A-Za-z_$]/.test(value);
}

function isIdentifierPart(value: string): boolean {
  return /[A-Za-z0-9_$]/.test(value);
}

function tokenizeTypeScript(source: string): Token[][] {
  const tokens: InternalToken[] = [];
  const length = source.length;
  let index = 0;

  while (index < length) {
    const char = source[index]!;
    const next = source[index + 1] ?? "";

    if (char === "/" && next === "/") {
      const start = index;
      index += 2;
      while (index < length && source[index] !== "\n") {
        index += 1;
      }
      tokens.push({ type: "comment", text: source.slice(start, index) });
      continue;
    }

    if (char === "/" && next === "*") {
      const start = index;
      index += 2;
      while (index < length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      if (index < length) {
        index += 2;
      }
      tokens.push({ type: "comment", text: source.slice(start, index) });
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      const quote = char;
      const start = index;
      index += 1;

      while (index < length) {
        const current = source[index]!;
        index += 1;

        if (current === "\\") {
          if (index < length) {
            index += 1;
          }
          continue;
        }

        if (current === quote) {
          break;
        }
      }

      tokens.push({ type: "string", text: source.slice(start, index) });
      continue;
    }

    if (isDigit(char)) {
      const start = index;
      index += 1;
      while (index < length && isDigit(source[index]!)) {
        index += 1;
      }
      if (source[index] === "." && isDigit(source[index + 1] ?? "")) {
        index += 1;
        while (index < length && isDigit(source[index]!)) {
          index += 1;
        }
      }
      tokens.push({ type: "number", text: source.slice(start, index) });
      continue;
    }

    if (isIdentifierStart(char)) {
      const start = index;
      index += 1;
      while (index < length && isIdentifierPart(source[index]!)) {
        index += 1;
      }

      const value = source.slice(start, index);
      tokens.push({
        type: KEYWORDS.has(value) ? "keyword" : "identifier",
        text: value,
      });
      continue;
    }

    tokens.push({ type: "default", text: char });
    index += 1;
  }

  const typedTokens: InternalToken[] = tokens.map((token) => ({ ...token }));
  let expectingType = false;

  for (const token of typedTokens) {
    if (token.type === "comment" || token.type === "string") {
      continue;
    }

    if (token.type === "keyword") {
      if (token.text === "extends") {
        expectingType = true;
      } else if (expectingType) {
        expectingType = false;
      }
      continue;
    }

    if (token.type === "identifier") {
      if (expectingType) {
        token.type = "type";
      }
      expectingType = false;
      continue;
    }

    if (token.type === "default") {
      if (token.text.trim().length === 0) {
        continue;
      }

      if (token.text === ":" || token.text === "<") {
        expectingType = true;
        continue;
      }

      if (expectingType && (token.text === "," || token.text === "|" || token.text === "&")) {
        continue;
      }

      if (token.text === ">" || token.text === "=" || token.text === "{" || token.text === "}" || token.text === ")" || token.text === ";" || token.text === "\n") {
        expectingType = false;
        continue;
      }

      if (expectingType) {
        expectingType = false;
      }
    }
  }

  const coloredTokens: Token[] = typedTokens.map((token) => ({
    text: token.text,
    type: token.type === "identifier" ? "default" : token.type,
  }));

  const lines: Token[][] = [[]];
  for (const token of coloredTokens) {
    const segments = token.text.split("\n");

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex]!;
      if (segment.length > 0) {
        lines[lines.length - 1]!.push({ type: token.type, text: segment });
      }

      if (segmentIndex < segments.length - 1) {
        lines.push([]);
      }
    }
  }

  return lines.length > 0 ? lines : [[]];
}

function tokenClassName(type: TokenType): string {
  if (type === "keyword") {
    return "text-purple-700 dark:text-purple-400";
  }
  if (type === "string") {
    return "text-emerald-700 dark:text-emerald-400";
  }
  if (type === "comment") {
    return "text-gray-500 italic";
  }
  if (type === "number") {
    return "text-amber-700 dark:text-amber-400";
  }
  if (type === "type") {
    return "text-cyan-700 dark:text-cyan-400";
  }

  return "text-gray-700 dark:text-gray-200";
}

export default function SourceModal({ title, sourceCode, onClose }: SourceModalProps) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const highlightedLines = useMemo(() => tokenizeTypeScript(sourceCode), [sourceCode]);
  const lineNumberWidth = useMemo(
    () => `${String(Math.max(highlightedLines.length, 1)).length + 3}ch`,
    [highlightedLines.length],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(sourceCode);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Copy failed");
    }
  }

  useEffect(() => {
    if (!copyStatus) {
      return;
    }

    const timerId = window.setTimeout(() => setCopyStatus(null), 1500);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [copyStatus]);

  return (
    <div className="fixed inset-0 z-50 bg-app-overlay px-4" onClick={onClose}>
      <div className="flex min-h-full items-center justify-center">
        <section
          className="flex max-h-[85vh] w-full max-w-4xl flex-col rounded-xl border border-app-border bg-app-surface shadow-2xl shadow-black/40"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="flex items-center justify-between gap-3 border-b border-app-border px-4 py-3">
            <h3 className="truncate text-base font-semibold text-app-text" title={title}>
              {title}
            </h3>
            <div className="flex items-center gap-2">
              {copyStatus ? <span className="text-xs text-app-text-muted">{copyStatus}</span> : null}
              <button
                type="button"
                onClick={() => void handleCopy()}
                className="rounded-lg border border-app-border-strong px-2.5 py-1 text-xs font-medium text-app-text-muted transition hover:border-app-border-strong hover:bg-app-surface-soft"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-app-border-strong px-2.5 py-1 text-xs font-medium text-app-text-muted transition hover:border-app-border-strong hover:bg-app-surface-soft"
                aria-label="Close source modal"
              >
                X
              </button>
            </div>
          </header>

          <div className="flex-1 overflow-auto px-4 py-3">
            <pre className="min-w-max rounded-lg border border-app-border bg-app-surface-alt py-2 font-mono text-sm">
              {highlightedLines.map((line, index) => (
                <code key={index} className="flex">
                  <span
                    className="sticky left-0 z-10 mr-3 shrink-0 select-none border-r border-app-border bg-app-surface-alt pr-3 text-right text-app-text-subtle"
                    style={{ width: lineNumberWidth }}
                  >
                    {index + 1}
                  </span>
                  <span className="whitespace-pre pr-4">
                    {line.length > 0
                      ? line.map((token, tokenIndex) => (
                          <span key={`${index}:${tokenIndex}:${token.text.length}`} className={tokenClassName(token.type)}>
                            {token.text}
                          </span>
                        ))
                      : " "}
                  </span>
                </code>
              ))}
            </pre>
          </div>

          <footer className="border-t border-app-border px-4 py-2 text-xs text-app-text-subtle">
            {highlightedLines.length} {highlightedLines.length === 1 ? "line" : "lines"}
          </footer>
        </section>
      </div>
    </div>
  );
}
