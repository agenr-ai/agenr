import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { Icon } from "./Icon";

/** Toast severity. */
type ToastKind = "success" | "error" | "info";

/** One active toast. */
interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

/** Toast API exposed through context. */
interface ToastApi {
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Auto-dismiss delay in milliseconds. */
const DISMISS_MS = 5200;

/**
 * Provides the toast API and renders the toast layer.
 *
 * @param props - Wrapped application content.
 * @returns The provider with the toast layer mounted.
 */
export function ToastProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [items, setItems] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, title: string, message?: string) => {
      const id = Date.now() + Math.random();
      setItems((current) => [...current, { id, kind, title, ...(message ? { message } : {}) }]);
      window.setTimeout(() => remove(id), DISMISS_MS);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (title, message) => push("success", title, message),
      error: (title, message) => push("error", title, message),
      info: (title, message) => push("info", title, message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-layer">
        {items.map((item) => (
          <div key={item.id} className={`toast toast--${item.kind}`}>
            <Icon name={item.kind === "success" ? "check" : item.kind === "error" ? "alert" : "bolt"} size={16} />
            <div className="toast__body">
              <div className="toast__title">{item.title}</div>
              {item.message ? <div className="toast__msg">{item.message}</div> : null}
            </div>
            <button className="btn btn--ghost btn--sm btn--icon" onClick={() => remove(item.id)} aria-label="Dismiss">
              <Icon name="close" size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Reads the toast API from context.
 *
 * @returns The toast API.
 * @throws Error When used outside a ToastProvider.
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) {
    throw new Error("useToast must be used within a ToastProvider.");
  }
  return api;
}
