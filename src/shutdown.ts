type ShutdownHandler = () => Promise<void>;

let shutdownRequested = false;
let shutdownSignal: NodeJS.Signals | null = null;
let signalCount = 0;
let installed = false;
let wakeCallback: (() => void) | null = null;

const shutdownHandlers: ShutdownHandler[] = [];

let sigintHandler: (() => void) | null = null;
let sigtermHandler: (() => void) | null = null;

function logLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function isShutdownRequested(): boolean {
  return shutdownRequested;
}

export function requestShutdown(): void {
  shutdownRequested = true;
}

export function getShutdownSignal(): NodeJS.Signals | null {
  return shutdownSignal;
}

export function onShutdown(handler: ShutdownHandler): void {
  shutdownHandlers.push(handler);
}

export function onWake(fn: (() => void) | null): void {
  wakeCallback = fn;
}

export async function runShutdownHandlers(): Promise<void> {
  // Run in LIFO order so the most recently registered resources are cleaned up first.
  for (let i = shutdownHandlers.length - 1; i >= 0; i -= 1) {
    const handler = shutdownHandlers[i];
    if (!handler) continue;
    try {
      await handler();
    } catch (err) {
      process.stderr.write(`[agenr] Shutdown handler failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

export function installSignalHandlers(): void {
  if (installed) return;
  installed = true;

  const handleSignal = (signal: NodeJS.Signals): void => {
    signalCount += 1;
    shutdownSignal = shutdownSignal ?? signal;

    if (signalCount === 1) {
      shutdownRequested = true;
      wakeCallback?.();
      logLine("[agenr] Shutting down gracefully, finishing current entry...");
      return;
    }

    logLine("[agenr] Forced shutdown");
    process.exit(1);
  };

  sigintHandler = () => handleSignal("SIGINT");
  sigtermHandler = () => handleSignal("SIGTERM");

  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);
}

// @internal - used by tests to avoid cross-test contamination.
export function resetShutdownForTests(): void {
  shutdownRequested = false;
  shutdownSignal = null;
  signalCount = 0;
  shutdownHandlers.length = 0;
  wakeCallback = null;

  if (installed) {
    if (sigintHandler) process.off("SIGINT", sigintHandler);
    if (sigtermHandler) process.off("SIGTERM", sigtermHandler);
  }

  sigintHandler = null;
  sigtermHandler = null;
  installed = false;
}
