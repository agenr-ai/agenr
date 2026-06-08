import type { ServerResponse } from "node:http";

/**
 * Server-sent events connection bound to one HTTP response.
 *
 * Wraps the raw `ServerResponse` so route handlers stream named JSON events
 * without managing the wire format. Heartbeats keep intermediaries from
 * closing an idle dreaming stream while a long pipeline stage runs.
 */
export class SseConnection {
  private closed = false;
  private readonly heartbeat: NodeJS.Timeout;
  private readonly closeListeners = new Set<() => void>();

  /**
   * Opens an SSE stream on the response and starts the heartbeat.
   *
   * @param response - HTTP response to stream events on.
   * @param heartbeatMs - Heartbeat interval in milliseconds.
   */
  public constructor(
    private readonly response: ServerResponse,
    heartbeatMs = 15_000,
  ) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");

    this.heartbeat = setInterval(() => {
      if (!this.closed) {
        this.response.write(": heartbeat\n\n");
      }
    }, heartbeatMs);
    this.heartbeat.unref?.();

    response.on("close", () => this.handleClose());
  }

  /**
   * Sends one named event with a JSON data payload.
   *
   * @param event - Event name clients listen on.
   * @param data - JSON-serializable payload.
   */
  public send(event: string, data: unknown): void {
    if (this.closed) {
      return;
    }

    this.response.write(`event: ${event}\n`);
    this.response.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * Registers a callback fired when the client disconnects.
   *
   * @param listener - Callback invoked once on close.
   */
  public onClose(listener: () => void): void {
    if (this.closed) {
      listener();
      return;
    }

    this.closeListeners.add(listener);
  }

  /**
   * Closes the stream and ends the response.
   */
  public close(): void {
    if (this.closed) {
      return;
    }

    this.handleClose();
    this.response.end();
  }

  /** Marks the connection closed, clears timers, and notifies listeners. */
  private handleClose(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    clearInterval(this.heartbeat);
    for (const listener of this.closeListeners) {
      try {
        listener();
      } catch {
        // Close listeners must never throw back into the response lifecycle.
      }
    }
    this.closeListeners.clear();
  }
}
