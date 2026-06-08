import { useCallback, useEffect, useRef, useState } from "react";

/** State and controls returned by useAsync. */
export interface AsyncState<T> {
  /** Resolved data, or null before the first success. */
  data: T | null;
  /** True while a request is in flight. */
  loading: boolean;
  /** Error from the most recent failed request, or null. */
  error: Error | null;
  /** Re-runs the async function. */
  refetch: () => void;
}

/**
 * Runs an async function and tracks loading, data, and error state.
 *
 * Re-runs whenever a dependency in `deps` changes, and exposes a stable
 * `refetch`. Stale responses are discarded if a newer run started, so rapid
 * filter changes never render an out-of-order result.
 *
 * @param fn - Async producer of the data.
 * @param deps - Dependency list that triggers a re-run on change.
 * @returns Async state with a refetch control.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: ReadonlyArray<unknown>): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const runId = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(() => {
    const current = ++runId.current;
    setLoading(true);
    setError(null);
    fnRef
      .current()
      .then((result) => {
        if (current === runId.current) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (current === runId.current) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error, refetch: run };
}
