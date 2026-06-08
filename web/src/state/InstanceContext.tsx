import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { api } from "../api/client";
import type { InstanceView } from "../api/types";

/** Instance registry state and controls exposed through context. */
interface InstanceContextValue {
  /** All registered instances. */
  instances: InstanceView[];
  /** Currently selected instance, or null. */
  selected: InstanceView | null;
  /** True while the registry is loading. */
  loading: boolean;
  /** Reloads the registry from the server. */
  refresh: () => Promise<void>;
  /** Selects an instance by id. */
  select: (id: string) => Promise<void>;
  /** Registers and selects a new instance. */
  register: (input: { name: string; configPath?: string; dbPath?: string; proceduresDir?: string }) => Promise<void>;
  /** Removes an instance by id. */
  remove: (id: string) => Promise<void>;
}

const InstanceContext = createContext<InstanceContextValue | null>(null);

/**
 * Loads the instance registry and provides selection controls to the tree.
 *
 * @param props - Wrapped application content.
 * @returns The provider.
 */
export function InstanceProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [instances, setInstances] = useState<InstanceView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const result = await api.listInstances();
    setInstances(result.instances);
    setSelectedId(result.selectedId);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh().catch(() => setLoading(false));
  }, [refresh]);

  const select = useCallback(
    async (id: string) => {
      await api.selectInstance(id);
      await refresh();
    },
    [refresh],
  );

  const register = useCallback(
    async (input: { name: string; configPath?: string; dbPath?: string; proceduresDir?: string }) => {
      const result = await api.registerInstance(input);
      setInstances(result.instances);
      setSelectedId(result.selectedId);
    },
    [],
  );

  const remove = useCallback(
    async (id: string) => {
      const result = await api.removeInstance(id);
      setInstances(result.instances);
      setSelectedId(result.selectedId);
    },
    [],
  );

  const selected = useMemo(() => instances.find((instance) => instance.record.id === selectedId) ?? null, [instances, selectedId]);

  const value = useMemo<InstanceContextValue>(
    () => ({ instances, selected, loading, refresh, select, register, remove }),
    [instances, selected, loading, refresh, select, register, remove],
  );

  return <InstanceContext.Provider value={value}>{children}</InstanceContext.Provider>;
}

/**
 * Reads the instance registry context.
 *
 * @returns The instance context value.
 * @throws Error When used outside an InstanceProvider.
 */
export function useInstances(): InstanceContextValue {
  const value = useContext(InstanceContext);
  if (!value) {
    throw new Error("useInstances must be used within an InstanceProvider.");
  }
  return value;
}
