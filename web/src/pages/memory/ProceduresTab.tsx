import { useState } from "react";

import { api } from "../../api/client";
import type { Procedure } from "../../api/types";
import { DataTable } from "../../components/DataTable";
import { Badge, Button, Card, CardBody, CardHeader, Drawer, EmptyState } from "../../components/primitives";
import { ErrorCard, Skeleton } from "../../components/states";
import { useAsync } from "../../hooks/useAsync";
import { useInstances } from "../../state/InstanceContext";
import { formatRelative, titleCase } from "../../lib/format";
import { ProcedureList } from "./ProcedureList";

/** Active-procedures browser (read side). */
export function ProceduresTab(): React.ReactElement {
  const { selected } = useInstances();
  const [active, setActive] = useState<Procedure | null>(null);
  const state = useAsync(() => api.procedures(), [selected?.record.id]);

  return (
    <div className="stack" style={{ gap: "var(--space-4)" }}>
      {state.loading && !state.data ? (
        <Skeleton height={200} />
      ) : state.error ? (
        <ErrorCard error={state.error} onRetry={state.refetch} />
      ) : (state.data?.procedures.length ?? 0) === 0 ? (
        <Card>
          <EmptyState icon="procedures" title="No procedures" message="Sync procedure YAML from the Procedure Editor to populate this list." />
        </Card>
      ) : (
        <Card>
          <CardHeader title={`Active procedures (${state.data?.procedures.length ?? 0})`} icon="procedures" actions={<Button variant="ghost" size="sm" icon="refresh" onClick={state.refetch} />} />
          <CardBody flush>
            <DataTable
              rows={state.data?.procedures ?? []}
              rowKey={(procedure) => procedure.id}
              onRowClick={(procedure) => setActive(procedure)}
              empty={{ icon: "procedures", title: "No procedures" }}
              columns={[
                { header: "Key", render: (procedure) => <span className="mono" style={{ fontSize: "var(--text-xs)" }}>{procedure.procedure_key}</span> },
                { header: "Title", render: (procedure) => <strong style={{ fontSize: "var(--text-sm)" }}>{procedure.title}</strong> },
                { header: "Steps", align: "right", render: (procedure) => <span className="numeric muted">{procedure.steps.length}</span> },
                { header: "Updated", align: "right", render: (procedure) => <span className="muted">{formatRelative(procedure.updated_at)}</span> },
              ]}
            />
          </CardBody>
        </Card>
      )}

      {active ? (
        <Drawer title={active.title} subtitle={<span className="mono">{active.procedure_key}</span>} onClose={() => setActive(null)}>
          <div className="stack" style={{ gap: "var(--space-4)" }}>
            <p className="secondary" style={{ fontSize: "var(--text-sm)" }}>{active.goal}</p>
            <ProcedureList title="When to use" items={active.when_to_use} />
            <ProcedureList title="When not to use" items={active.when_not_to_use} />
            <ProcedureList title="Prerequisites" items={active.prerequisites} />
            <div className="stack" style={{ gap: "var(--space-2)" }}>
              <span className="section-title">Steps</span>
              {active.steps.map((step, index) => (
                <div key={index} className="card" style={{ padding: "var(--space-3)" }}>
                  <Badge status="accent">{titleCase(String(step.kind ?? "step"))}</Badge>
                  <p className="secondary" style={{ fontSize: "var(--text-sm)", marginTop: "var(--space-2)" }}>
                    {String((step as { description?: string }).description ?? "")}
                  </p>
                </div>
              ))}
            </div>
            <ProcedureList title="Verification" items={active.verification} />
            <ProcedureList title="Failure modes" items={active.failure_modes} />
          </div>
        </Drawer>
      ) : null}
    </div>
  );
}
