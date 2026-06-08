import { useState } from "react";

import { ApiError, api, type DurableQueryInput } from "../api/client";
import type { Episode, Procedure } from "../api/types";
import { DataTable } from "../components/DataTable";
import { DURABLE_TYPES, DurableContentFields, emptyDurableContent, toStorePayload, type DurableContentValue } from "../components/DurableFields";
import { DurableTraceDrawer } from "../components/DurableTraceDrawer";
import { Icon } from "../components/Icon";
import { Badge, Button, Card, CardBody, CardHeader, Chip, Drawer, EmptyState, Input, KeyValue, Select, Tabs } from "../components/primitives";
import { ErrorCard, RequireInstance, Skeleton } from "../components/states";
import { useToast } from "../components/Toast";
import { useAsync } from "../hooks/useAsync";
import { useInstances } from "../state/InstanceContext";
import { formatDateTime, formatRelative, titleCase, truncate } from "../lib/format";
import { durableState, durableStateVariant } from "../lib/status";

/** Page size for the durable browser. */
const PAGE_SIZE = 25;

/**
 * Memory Explorer page: browse durables, episodes, and procedures.
 *
 * @returns The rendered explorer.
 */
export function MemoryPage(): React.ReactElement {
  return (
    <RequireInstance>
      <MemoryInner />
    </RequireInstance>
  );
}

/** Explorer content shown once an instance is confirmed selected. */
function MemoryInner(): React.ReactElement {
  const [tab, setTab] = useState("durables");
  return (
    <div className="stack" style={{ gap: "var(--space-6)" }}>
      <div className="page-head">
        <div className="page-head__lead">
          <h2>Memory explorer</h2>
          <p>Inspect the knowledge corpus. Durable content is lifecycle-managed: retire or supersede rather than editing in place.</p>
        </div>
      </div>

      <Tabs
        tabs={[
          { id: "durables", label: "Durables" },
          { id: "episodes", label: "Episodes" },
          { id: "procedures", label: "Procedures" },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === "durables" ? <DurablesTab /> : null}
      {tab === "episodes" ? <EpisodesTab /> : null}
      {tab === "procedures" ? <ProceduresTab /> : null}
    </div>
  );
}

/** Durable browser with filters, pagination, trace drawer, and store form. */
function DurablesTab(): React.ReactElement {
  const { selected } = useInstances();
  const [text, setText] = useState("");
  const [stateFilter, setStateFilter] = useState("active");
  const [type, setType] = useState("");
  const [claimPrefix, setClaimPrefix] = useState("");
  const [sort, setSort] = useState("updated_at");
  const [page, setPage] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [storing, setStoring] = useState(false);

  const facets = useAsync(() => api.memoryFacets(), [selected?.record.id]);

  const queryInput: DurableQueryInput = {
    text: text.trim() || undefined,
    state: stateFilter,
    types: type ? [type] : undefined,
    claimKeyPrefix: claimPrefix || undefined,
    sort,
    direction: "desc",
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };

  const state = useAsync(() => api.durables(queryInput), [selected?.record.id, text, stateFilter, type, claimPrefix, sort, page, reloadToken]);

  const reload = (): void => setReloadToken((value) => value + 1);
  const total = state.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="stack" style={{ gap: "var(--space-4)" }}>
      <div className="filters">
        <div className="filters__search">
          <Icon name="search" size={15} />
          <Input
            placeholder="Search subject and content"
            value={text}
            onChange={(event) => {
              setPage(0);
              setText(event.target.value);
            }}
          />
        </div>
        <div className="segmented">
          {["active", "stale", "superseded", "all"].map((value) => (
            <button
              key={value}
              className={stateFilter === value ? "is-active" : ""}
              onClick={() => {
                setPage(0);
                setStateFilter(value);
              }}
            >
              {titleCase(value)}
            </button>
          ))}
        </div>
        <Select
          value={type}
          onChange={(event) => {
            setPage(0);
            setType(event.target.value);
          }}
        >
          <option value="">All types</option>
          {DURABLE_TYPES.map((value) => (
            <option key={value} value={value}>
              {titleCase(value)}
            </option>
          ))}
        </Select>
        {facets.data && facets.data.claimKeyPrefixes.length > 0 ? (
          <Select
            value={claimPrefix}
            onChange={(event) => {
              setPage(0);
              setClaimPrefix(event.target.value);
            }}
          >
            <option value="">All claim keys</option>
            {facets.data.claimKeyPrefixes.map((prefix) => (
              <option key={prefix} value={prefix}>
                {prefix}
              </option>
            ))}
          </Select>
        ) : null}
        <Select value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="updated_at">Recently updated</option>
          <option value="created_at">Recently created</option>
          <option value="importance">Importance</option>
          <option value="recall_count">Most recalled</option>
          <option value="last_recalled_at">Recently recalled</option>
        </Select>
        <div className="grow" />
        <Button variant="ghost" size="sm" icon="refresh" onClick={state.refetch} />
        <Button variant="primary" size="sm" icon="plus" onClick={() => setStoring(true)}>
          Store durable
        </Button>
      </div>

      <Card>
        <CardBody flush>
          {state.loading && !state.data ? (
            <div style={{ padding: "var(--space-5)" }}>
              <Skeleton height={220} />
            </div>
          ) : state.error ? (
            <div style={{ padding: "var(--space-5)" }}>
              <ErrorCard error={state.error} onRetry={state.refetch} />
            </div>
          ) : (
            <>
              <DataTable
                rows={state.data?.durables ?? []}
                rowKey={(durable) => durable.id}
                onRowClick={(durable) => setActiveId(durable.id)}
                empty={{ icon: "memory", title: "No durables match", message: "Adjust filters or store a new durable." }}
                columns={[
                  {
                    header: "Subject",
                    render: (durable) => (
                      <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                        <strong className="truncate" style={{ fontSize: "var(--text-sm)", maxWidth: 360 }}>
                          {durable.subject}
                        </strong>
                        <span className="muted truncate" style={{ fontSize: "var(--text-xs)", maxWidth: 360 }}>
                          {truncate(durable.content, 90)}
                        </span>
                      </div>
                    ),
                  },
                  { header: "Type", render: (durable) => <Badge status="neutral">{titleCase(durable.type)}</Badge> },
                  { header: "State", render: (durable) => <Badge status={durableStateVariant(durableState(durable))}>{durableState(durable)}</Badge> },
                  { header: "Imp.", align: "right", render: (durable) => <span className="numeric">{durable.importance.toFixed(2)}</span> },
                  { header: "Recalls", align: "right", render: (durable) => <span className="numeric muted">{durable.recall_count}</span> },
                  { header: "Updated", align: "right", render: (durable) => <span className="muted" title={formatDateTime(durable.updated_at)}>{formatRelative(durable.updated_at)}</span> },
                ]}
              />
              <div className="pager">
                <span>
                  {total.toLocaleString()} result{total === 1 ? "" : "s"}
                </span>
                <div className="row" style={{ gap: "var(--space-2)" }}>
                  <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>
                    Prev
                  </Button>
                  <span className="numeric">
                    {page + 1} / {pageCount}
                  </span>
                  <Button variant="ghost" size="sm" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => value + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardBody>
      </Card>

      {activeId ? <DurableTraceDrawer id={activeId} onClose={() => setActiveId(null)} onMutated={reload} /> : null}
      {storing ? <StoreDurableDrawer onClose={() => setStoring(false)} onStored={() => { setStoring(false); reload(); }} /> : null}
    </div>
  );
}

/** Drawer form for storing a brand-new durable. */
function StoreDurableDrawer({ onClose, onStored }: { onClose: () => void; onStored: () => void }): React.ReactElement {
  const toast = useToast();
  const [value, setValue] = useState<DurableContentValue>(emptyDurableContent);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!value.subject.trim() || !value.content.trim()) {
      toast.error("Incomplete", "Subject and content are required.");
      return;
    }
    setBusy(true);
    try {
      await api.storeDurable(toStorePayload(value));
      toast.success("Durable stored");
      onStored();
    } catch (error) {
      toast.error("Store failed", error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title="Store durable"
      subtitle="Adds a new knowledge record through the shared store pipeline"
      onClose={onClose}
      actions={
        <Button variant="primary" size="sm" icon="check" loading={busy} onClick={() => void submit()}>
          Store
        </Button>
      }
    >
      <DurableContentFields value={value} onChange={setValue} />
    </Drawer>
  );
}

/** Recent-episodes browser. */
function EpisodesTab(): React.ReactElement {
  const { selected } = useInstances();
  const [project, setProject] = useState("");
  const [active, setActive] = useState<Episode | null>(null);
  const state = useAsync(() => api.episodes({ project: project.trim() || undefined, limit: 50 }), [selected?.record.id, project]);

  return (
    <div className="stack" style={{ gap: "var(--space-4)" }}>
      <div className="filters">
        <div className="filters__search">
          <Icon name="search" size={15} />
          <Input placeholder="Filter by project" value={project} onChange={(event) => setProject(event.target.value)} />
        </div>
        <div className="grow" />
        <Button variant="ghost" size="sm" icon="refresh" onClick={state.refetch} />
      </div>

      {state.loading && !state.data ? (
        <Skeleton height={200} />
      ) : state.error ? (
        <ErrorCard error={state.error} onRetry={state.refetch} />
      ) : (state.data?.episodes.length ?? 0) === 0 ? (
        <Card>
          <EmptyState icon="history" title="No episodes" message="No session episodes have been recorded for this scope." />
        </Card>
      ) : (
        <div className="stack" style={{ gap: "var(--space-3)" }}>
          {state.data?.episodes.map((episode) => (
            <Card key={episode.id}>
              <CardBody>
                <div className="spread" style={{ gap: "var(--space-3)", alignItems: "flex-start" }}>
                  <div className="grow stack" style={{ gap: "var(--space-2)", minWidth: 0 }}>
                    <div className="row wrap" style={{ gap: "var(--space-2)" }}>
                      <Badge status="info">{episode.source}</Badge>
                      {episode.project ? <Chip>{episode.project}</Chip> : null}
                      {episode.activityLevel ? <Chip>{episode.activityLevel}</Chip> : null}
                      <span className="muted" style={{ fontSize: "var(--text-xs)" }}>{formatRelative(episode.startedAt)}</span>
                    </div>
                    <p className="secondary" style={{ fontSize: "var(--text-sm)" }}>
                      {episode.summary ? truncate(episode.summary, 280) : "(no summary)"}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" icon="arrow-right" onClick={() => setActive(episode)}>
                    Open
                  </Button>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {active ? (
        <Drawer title="Episode" subtitle={<span className="mono">{active.id}</span>} onClose={() => setActive(null)}>
          <div className="stack" style={{ gap: "var(--space-4)" }}>
            <KeyValue
              rows={[
                { key: "Source", value: active.source },
                { key: "Project", value: active.project ?? "-" },
                { key: "Started", value: formatDateTime(active.startedAt) },
                { key: "Ended", value: active.endedAt ? formatDateTime(active.endedAt) : "-" },
                { key: "Messages", value: active.messageCount != null ? String(active.messageCount) : "-" },
                { key: "Activity", value: active.activityLevel ?? "-" },
              ]}
            />
            <div className="stack" style={{ gap: "var(--space-2)" }}>
              <span className="section-title">Summary</span>
              <div className="code-surface">{active.summary ?? "(no summary)"}</div>
            </div>
          </div>
        </Drawer>
      ) : null}
    </div>
  );
}

/** Active-procedures browser (read side). */
function ProceduresTab(): React.ReactElement {
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

/** Bulleted list block used in the procedure detail drawer. */
function ProcedureList({ title, items }: { title: string; items: string[] }): React.ReactElement | null {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="stack" style={{ gap: "var(--space-2)" }}>
      <span className="section-title">{title}</span>
      <ul style={{ paddingLeft: "var(--space-5)", display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((item, index) => (
          <li key={index} className="secondary" style={{ fontSize: "var(--text-sm)" }}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
