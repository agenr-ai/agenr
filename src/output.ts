import fs from "node:fs/promises";
import path from "node:path";
import type { ExtractionReport } from "./types.js";

function summarizeStats(stats: {
  chunks: number;
  successful_chunks: number;
  failed_chunks: number;
  raw_entries: number;
  deduped_entries: number;
  warnings: string[];
}): string {
  return [
    `chunks=${stats.successful_chunks}/${stats.chunks} successful`,
    `failed=${stats.failed_chunks}`,
    `raw=${stats.raw_entries}`,
    `deduped=${stats.deduped_entries}`,
    `warnings=${stats.warnings.length}`,
  ].join(" | ");
}

function formatEntryBullet(entry: {
  type: string;
  subject: string;
  content: string;
  confidence: string;
  expiry: string;
  tags: string[];
  source: { context: string };
}): string {
  const tags = entry.tags.length > 0 ? entry.tags.join(", ") : "none";
  return `- [${entry.type}] **${entry.subject}**: ${entry.content} (confidence=${entry.confidence}, expiry=${entry.expiry}, tags=${tags}, source=${entry.source.context})`;
}

export function formatJson(report: ExtractionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatMarkdown(report: ExtractionReport): string {
  const lines: string[] = [];
  lines.push(`# Knowledge Extract Report`);
  lines.push("");
  lines.push(`- Version: ${report.version}`);
  lines.push(`- Extracted At: ${report.extracted_at}`);
  lines.push(`- Provider: ${report.provider}`);
  lines.push(`- Model: ${report.model}`);
  lines.push("");

  for (const [file, payload] of Object.entries(report.files)) {
    lines.push(`## ${file}`);
    lines.push("");
    lines.push(`_Stats: ${summarizeStats(payload.stats)}_`);
    lines.push("");

    if (payload.entries.length === 0) {
      lines.push(`- No knowledge entries extracted.`);
    } else {
      for (const entry of payload.entries) {
        lines.push(formatEntryBullet(entry));
      }
    }

    if (payload.stats.warnings.length > 0) {
      lines.push("");
      lines.push(`Warnings:`);
      for (const warning of payload.stats.warnings) {
        lines.push(`- ${warning}`);
      }
    }

    lines.push("");
  }

  lines.push(`## Summary`);
  lines.push("");
  lines.push(`- Files: ${report.summary.files}`);
  lines.push(`- Chunks: ${report.summary.successful_chunks}/${report.summary.chunks} successful`);
  lines.push(`- Failed Chunks: ${report.summary.failed_chunks}`);
  lines.push(`- Entries: ${report.summary.deduped_entries} deduped (${report.summary.raw_entries} raw)`);
  lines.push(`- Warnings: ${report.summary.warnings}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function sanitizeFileName(value: string): string {
  return value
    .replace(/[\\/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 150);
}

function extensionForFormat(format: "json" | "markdown"): string {
  return format === "json" ? ".knowledge.json" : ".knowledge.md";
}

async function uniqueOutputPath(basePath: string): Promise<string> {
  let attempt = 1;
  let candidate = basePath;

  while (true) {
    try {
      await fs.access(candidate);
      attempt += 1;
      const ext = path.extname(basePath);
      const stem = basePath.slice(0, -ext.length);
      candidate = `${stem}-${attempt}${ext}`;
    } catch {
      return candidate;
    }
  }
}

export async function writeOutput(params: {
  report: ExtractionReport;
  format: "json" | "markdown";
  output?: string;
  split: boolean;
}): Promise<string[]> {
  const { report, format, output, split } = params;

  if (!split) {
    const content = format === "json" ? formatJson(report) : formatMarkdown(report);
    if (!output) {
      process.stdout.write(content);
      return [];
    }
    await fs.writeFile(output, content, "utf8");
    return [path.resolve(output)];
  }

  if (!output) {
    throw new Error("--split requires --output <directory>");
  }

  const stat = await fs
    .stat(output)
    .then((value) => value)
    .catch(() => null);

  if (stat && !stat.isDirectory()) {
    throw new Error(`Split output path must be a directory: ${output}`);
  }

  await fs.mkdir(output, { recursive: true });
  const writtenPaths: string[] = [];

  for (const [file, payload] of Object.entries(report.files)) {
    const singleReport: ExtractionReport = {
      ...report,
      files: {
        [file]: payload,
      },
      summary: {
        files: 1,
        chunks: payload.stats.chunks,
        successful_chunks: payload.stats.successful_chunks,
        failed_chunks: payload.stats.failed_chunks,
        raw_entries: payload.stats.raw_entries,
        deduped_entries: payload.stats.deduped_entries,
        warnings: payload.stats.warnings.length,
      },
    };

    const ext = extensionForFormat(format);
    const safe = sanitizeFileName(path.basename(file) || "transcript");
    const desired = path.join(output, `${safe}${ext}`);
    const target = await uniqueOutputPath(desired);
    const content = format === "json" ? formatJson(singleReport) : formatMarkdown(singleReport);

    await fs.writeFile(target, content, "utf8");
    writtenPaths.push(path.resolve(target));
  }

  return writtenPaths;
}
