import chalk from "chalk";

import { APP_VERSION } from "./version.js";

/** Brand color palette for CLI output. */
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

/** Returns the agenr ASCII banner with the current version. */
export function banner(): string {
  const lines = [
    chalk.hex("#8B5CF6")(" █████╗  ██████╗ ███████╗███╗   ██╗██████╗"),
    chalk.hex("#9B6BF7")("██╔══██╗██╔════╝ ██╔════╝████╗  ██║██╔══██╗"),
    chalk.hex("#B88DF0")("███████║██║  ███╗█████╗  ██╔██╗ ██║██████╔╝"),
    chalk.hex("#C9A046")("██╔══██║██║   ██║██╔══╝  ██║╚██╗██║██╔══██╗"),
    chalk.hex("#D4AA40")("██║  ██║╚██████╔╝███████╗██║ ╚████║██║  ██║"),
    chalk.hex("#E0B830")("╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝"),
  ];

  return `\n${lines.join("\n")}\n${ui.dim("  agenr")}  ${ui.dim("AGENt memoRy")}  ${ui.dim(`v${APP_VERSION}`)}`;
}

/**
 * Formats a label-value pair for CLI display.
 *
 * @param label - Human-readable label text.
 * @param value - Value text paired with the label.
 * @returns Colorized label-value output.
 */
export function formatLabel(label: string, value: string): string {
  return ui.label(`${label}:`) + " " + ui.value(value);
}

/**
 * Formats an error message with the agenr error prefix.
 *
 * @param text - Error text to display.
 * @returns Colorized error output.
 */
export function formatError(text: string): string {
  return ui.error("error") + " " + text;
}

/**
 * Formats a warning message with the agenr warning prefix.
 *
 * @param text - Warning text to display.
 * @returns Colorized warning output.
 */
export function formatWarn(text: string): string {
  return ui.warn("warning") + " " + text;
}

/**
 * Formats a success message with the agenr success prefix.
 *
 * @param text - Success text to display.
 * @returns Colorized success output.
 */
export function formatSuccess(text: string): string {
  return ui.success("ok") + " " + text;
}
