import os from "node:os";
import path from "node:path";

import * as clack from "@clack/prompts";

export { banner, formatError, formatLabel, formatSuccess, formatWarn, ui } from "../ui.js";

/** One selectable value shown in an interactive CLI prompt. */
export interface PromptOption<T> {
  /** Value returned when the option is selected. */
  value: T;
  /** Human-readable label rendered in the prompt. */
  label: string;
  /** Optional hint rendered alongside the label. */
  hint?: string;
}

/** Shared shape for simple yes-no confirmation prompts. */
export interface ConfirmPromptOptions {
  /** Prompt body shown to the user. */
  message: string;
  /** Optional default confirmation value. */
  initialValue?: boolean;
}

/** Shared shape for hidden password prompts. */
export interface PasswordPromptOptions {
  /** Prompt body shown to the user. */
  message: string;
  /** Optional validation callback for entered text. */
  validate?: (value: string | undefined) => string | Error | undefined;
}

/** Shared shape for free-form text prompts. */
export interface TextPromptOptions {
  /** Prompt body shown to the user. */
  message: string;
  /** Optional initial field value. */
  initialValue?: string;
  /** Optional placeholder shown when the field is empty. */
  placeholder?: string;
  /** Optional validation callback for entered text. */
  validate?: (value: string | undefined) => string | Error | undefined;
}

/** Shared shape for select prompts with typed values. */
export interface SelectPromptOptions<T> {
  /** Prompt body shown to the user. */
  message: string;
  /** Ordered choice list. */
  options: PromptOption<T>[];
  /** Optional initially selected value. */
  initialValue?: T;
}

/** Spinner contract used by interactive setup flows. */
export interface WizardSpinner {
  /** Starts the spinner with a status message. */
  start(message: string): void;
  /** Stops the spinner and renders a final status message. */
  stop(message?: string): void;
  /** Updates the spinner message while it is active. */
  message(message: string): void;
}

/** Logging contract used by interactive setup flows. */
export interface WizardLog {
  /** Emits an informational log line. */
  info(message: string): void;
  /** Emits a warning log line. */
  warn(message: string): void;
  /** Emits an error log line. */
  error(message: string): void;
  /** Emits a step/progress log line. */
  step(message: string): void;
}

/** Thin wrapper over `@clack/prompts` used by setup and init flows. */
export interface WizardPrompts {
  /** Shows the intro banner for an interactive flow. */
  intro(message: string): void;
  /** Shows the final outro line for an interactive flow. */
  outro(message: string): void;
  /** Shows a titled note block. */
  note(message: string, title?: string): void;
  /** Shows the standard cancellation line. */
  cancel(message: string): void;
  /** Returns whether a prompt result is the clack cancel sentinel. */
  isCancel(value: unknown): value is symbol;
  /** Shows a typed select prompt. */
  select<T>(options: SelectPromptOptions<T>): Promise<T | symbol>;
  /** Shows a confirmation prompt. */
  confirm(options: ConfirmPromptOptions): Promise<boolean | symbol>;
  /** Shows a hidden password prompt. */
  password(options: PasswordPromptOptions): Promise<string | symbol>;
  /** Shows a free-form text prompt. */
  text(options: TextPromptOptions): Promise<string | symbol>;
  /** Creates a spinner instance. */
  spinner(): WizardSpinner;
  /** Shared log methods. */
  log: WizardLog;
}

/**
 * Creates the default `@clack/prompts` wrapper used by interactive CLI flows.
 *
 * @returns Prompt driver backed by `@clack/prompts`.
 */
export function createCliPrompts(): WizardPrompts {
  return {
    intro: (message) => clack.intro(message),
    outro: (message) => clack.outro(message),
    note: (message, title) => clack.note(message, title),
    cancel: (message) => clack.cancel(message),
    isCancel: clack.isCancel,
    select: async <T>(options: SelectPromptOptions<T>): Promise<T | symbol> => {
      return (await clack.select({
        message: options.message,
        options: options.options as never,
        ...(options.initialValue !== undefined ? { initialValue: options.initialValue } : {}),
      })) as T | symbol;
    },
    confirm: async (options: ConfirmPromptOptions): Promise<boolean | symbol> => {
      return (await clack.confirm(options)) as boolean | symbol;
    },
    password: async (options: PasswordPromptOptions): Promise<string | symbol> => {
      return (await clack.password(options)) as string | symbol;
    },
    text: async (options: TextPromptOptions): Promise<string | symbol> => {
      return (await clack.text(options)) as string | symbol;
    },
    spinner: () => clack.spinner(),
    log: clack.log,
  };
}

const cliPrompts = createCliPrompts();

export { cliPrompts };

/**
 * Resolves a user-entered path into an absolute filesystem path when possible.
 *
 * `:memory:` and `file:` URLs are preserved as-is.
 *
 * @param value - Raw user-provided path value.
 * @returns Normalized path string suitable for config storage.
 */
export function resolveUserPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === ":memory:" || trimmed.startsWith("file:")) {
    return trimmed;
  }

  if (trimmed === "~") {
    return os.homedir();
  }

  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  if (trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  return path.resolve(trimmed);
}

/**
 * Formats a path for human-readable display by shortening the current home dir.
 *
 * @param filePath - Absolute or relative filesystem path.
 * @returns Display-oriented path string.
 */
export function formatPathForDisplay(filePath: string): string {
  const home = os.homedir();
  const resolvedPath = filePath.trim();
  return resolvedPath.startsWith(home) ? `~${resolvedPath.slice(home.length)}` : resolvedPath;
}
