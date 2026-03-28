import type {
  ConfirmPromptOptions,
  PasswordPromptOptions,
  SelectPromptOptions,
  TextPromptOptions,
  WizardLog,
  WizardPrompts,
  WizardSpinner,
} from "../../src/cli/ui.js";

/** Shared cancel sentinel used by prompt-driven unit tests. */
export const CANCEL = Symbol("cancel");

/** Simple spinner recorder used by fake interactive prompt flows. */
class FakeSpinner implements WizardSpinner {
  /** Spinner event log recorded in call order. */
  public readonly events: string[] = [];

  start(message: string): void {
    this.events.push(`start:${message}`);
  }

  stop(message?: string): void {
    this.events.push(`stop:${message ?? ""}`);
  }

  message(message: string): void {
    this.events.push(`message:${message}`);
  }
}

/** In-memory log collector used by prompt-driven unit tests. */
class FakeLog implements WizardLog {
  /** Informational messages emitted by the flow. */
  public readonly infoMessages: string[] = [];
  /** Warning messages emitted by the flow. */
  public readonly warnMessages: string[] = [];
  /** Error messages emitted by the flow. */
  public readonly errorMessages: string[] = [];
  /** Step messages emitted by the flow. */
  public readonly stepMessages: string[] = [];

  info(message: string): void {
    this.infoMessages.push(message);
  }

  warn(message: string): void {
    this.warnMessages.push(message);
  }

  error(message: string): void {
    this.errorMessages.push(message);
  }

  step(message: string): void {
    this.stepMessages.push(message);
  }
}

/**
 * Fake prompt driver for unit-testing clack-backed wizard logic.
 */
export class FakePrompts implements WizardPrompts {
  /** Intro banner strings shown by the flow. */
  public readonly intros: string[] = [];
  /** Outro strings shown by the flow. */
  public readonly outros: string[] = [];
  /** Note blocks shown by the flow. */
  public readonly notes: Array<{ message: string; title?: string }> = [];
  /** Cancellation lines shown by the flow. */
  public readonly cancellations: string[] = [];
  /** Spinner instances created by the flow. */
  public readonly spinners: FakeSpinner[] = [];
  /** Shared log collector used by the flow. */
  public readonly log = new FakeLog();

  private readonly responses: unknown[];

  /**
   * Creates a fake prompt driver with a fixed response queue.
   *
   * @param responses - Prompt results returned in FIFO order.
   */
  constructor(responses: unknown[] = []) {
    this.responses = [...responses];
  }

  intro(message: string): void {
    this.intros.push(message);
  }

  outro(message: string): void {
    this.outros.push(message);
  }

  note(message: string, title?: string): void {
    this.notes.push({ message, title });
  }

  cancel(message: string): void {
    this.cancellations.push(message);
  }

  isCancel(value: unknown): value is symbol {
    return value === CANCEL;
  }

  async select<T>(_options: SelectPromptOptions<T>): Promise<T | symbol> {
    return this.nextResponse<T | symbol>();
  }

  async confirm(_options: ConfirmPromptOptions): Promise<boolean | symbol> {
    return this.nextResponse<boolean | symbol>();
  }

  async password(_options: PasswordPromptOptions): Promise<string | symbol> {
    return this.nextResponse<string | symbol>();
  }

  async text(_options: TextPromptOptions): Promise<string | symbol> {
    return this.nextResponse<string | symbol>();
  }

  spinner(): WizardSpinner {
    const spinner = new FakeSpinner();
    this.spinners.push(spinner);
    return spinner;
  }

  /** Returns the next queued prompt response. */
  private nextResponse<T>(): T {
    if (this.responses.length === 0) {
      throw new Error("FakePrompts ran out of queued responses.");
    }

    return this.responses.shift() as T;
  }
}
