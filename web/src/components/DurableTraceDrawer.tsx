import { useState } from "react";

import { api } from "../api/client";
import type { DurableTrace } from "../api/types";
import { DurableMetadataForm } from "./durable/DurableMetadataForm";
import { DurableSupersedeForm } from "./durable/DurableSupersedeForm";
import { DurableTraceView } from "./durable/DurableTraceView";
import { Button, Drawer } from "./primitives";
import { ErrorCard, Skeleton } from "./states";
import { useAsync } from "../hooks/useAsync";

/** Drawer interaction mode. */
type Mode = "view" | "metadata" | "supersede";

/**
 * Durable detail drawer: trace, lineage, activity, and lifecycle actions.
 *
 * Durable content is never edited in place; the drawer offers lifecycle-correct
 * mutations only (retire by closing validity, supersede with a successor, and
 * metadata-only edits), matching the corpus's append-and-supersede model.
 *
 * @param props - Durable id, close handler, and post-mutation callback.
 * @returns The rendered drawer.
 */
export function DurableTraceDrawer({ id, onClose, onMutated }: { id: string; onClose: () => void; onMutated: () => void }): React.ReactElement {
  const state = useAsync<DurableTrace>(() => api.durable(id), [id]);
  const [tab, setTab] = useState("overview");
  const [mode, setMode] = useState<Mode>("view");

  const refreshAll = (): void => {
    state.refetch();
    onMutated();
  };

  return (
    <Drawer
      title="Durable detail"
      subtitle={<span className="mono">{id}</span>}
      onClose={onClose}
      actions={
        mode === "view" && state.data ? (
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <Button variant="ghost" size="sm" icon="edit" onClick={() => setMode("metadata")}>
              Metadata
            </Button>
            <Button variant="ghost" size="sm" icon="history" onClick={() => setMode("supersede")}>
              Supersede
            </Button>
          </div>
        ) : undefined
      }
    >
      {state.loading ? (
        <Skeleton height={320} />
      ) : state.error ? (
        <ErrorCard error={state.error} onRetry={state.refetch} />
      ) : state.data ? (
        mode === "metadata" ? (
          <DurableMetadataForm durable={state.data.durable} onCancel={() => setMode("view")} onSaved={() => { setMode("view"); refreshAll(); }} />
        ) : mode === "supersede" ? (
          <DurableSupersedeForm durable={state.data.durable} onCancel={() => setMode("view")} onSaved={() => { setMode("view"); refreshAll(); }} />
        ) : (
          <DurableTraceView trace={state.data} tab={tab} onTab={setTab} onMutated={refreshAll} />
        )
      ) : null}
    </Drawer>
  );
}
