import chalk from "chalk";

export const ui = {
  brand: chalk.hex("#8B5CF6"),
  success: chalk.green,
  error: chalk.red,
  warn: chalk.yellow,
  dim: chalk.dim,
  bold: chalk.bold,
  label: chalk.cyan,
  value: chalk.white,
  muted: chalk.gray,
  header: chalk.bold.hex("#8B5CF6"),
};

export function banner(): string {
  return ui.header("AGENR") + ui.dim(" -- AGENt memoRy");
}

export function formatLabel(label: string, value: string): string {
  return ui.label(`${label}:`) + " " + ui.value(value);
}

export function formatDim(text: string): string {
  return ui.dim(text);
}

export function formatError(text: string): string {
  return ui.error("error") + " " + text;
}

export function formatWarn(text: string): string {
  return ui.warn("warning") + " " + text;
}

export function formatSuccess(text: string): string {
  return ui.success("ok") + " " + text;
}
