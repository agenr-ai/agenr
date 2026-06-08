import { useEffect, useRef, useState } from "react";

import { dreamStreamUrl } from "../api/client";
import type { DreamJobEvent, DreamJobStatus } from "../api/types";

/** Live state of a streamed dreaming job. */
export interface DreamStreamState {
  /** Ordered, de-duplicated events received so far. */
  events: DreamJobEvent[];
  /** Latest lifecycle status, or null before the first status event. */
  status: DreamJobStatus | null;
  /** True once the stream has ended. */
  finished: boolean;
}

/**
 * Subscribes to a dreaming job's server-sent event stream.
 *
 * Opens an `EventSource` for the job, replays the coordinator's buffered
 * events, and tracks live progress. Events are de-duplicated by sequence so a
 * reconnect or buffered replay never double-renders. Passing `null` tears the
 * stream down.
 *
 * @param jobId - Job to stream, or null to disconnect.
 * @param onFinished - Optional callback fired once when the job ends.
 * @returns Live stream state.
 */
export function useDreamStream(jobId: string | null, onFinished?: () => void): DreamStreamState {
  const [events, setEvents] = useState<DreamJobEvent[]>([]);
  const [status, setStatus] = useState<DreamJobStatus | null>(null);
  const [finished, setFinished] = useState(false);
  const seen = useRef<Set<number>>(new Set());
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  useEffect(() => {
    if (!jobId) {
      return;
    }

    setEvents([]);
    setStatus(null);
    setFinished(false);
    seen.current = new Set();

    const source = new EventSource(dreamStreamUrl(jobId));

    const ingest = (raw: string): void => {
      try {
        const event = JSON.parse(raw) as DreamJobEvent;
        if (seen.current.has(event.seq)) {
          return;
        }
        seen.current.add(event.seq);
        setEvents((current) => [...current, event]);
        if (event.kind === "status" && event.status) {
          setStatus(event.status);
        }
      } catch {
        // Ignore malformed event payloads.
      }
    };

    const onProgress = (event: MessageEvent): void => ingest(event.data as string);
    const onStatus = (event: MessageEvent): void => ingest(event.data as string);
    const onEnd = (): void => {
      setFinished(true);
      source.close();
      finishedRef.current?.();
    };

    source.addEventListener("progress", onProgress);
    source.addEventListener("status", onStatus);
    source.addEventListener("end", onEnd);
    source.addEventListener("error", () => {
      // The browser auto-reconnects on transient errors; a closed stream ends.
      if (source.readyState === EventSource.CLOSED) {
        setFinished(true);
      }
    });

    return () => {
      source.close();
    };
  }, [jobId]);

  return { events, status, finished };
}
