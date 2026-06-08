import { useState } from "react";

import { api, type DurableQueryInput } from "../../api/client";
import { DataTable } from "../../components/DataTable";
import { DURABLE_TYPES } from "../../components/DurableFields";
import { DurableTraceDrawer } from "../../components/DurableTraceDrawer";
import { Icon } from "../../components/Icon";
import { Badge, Button, Card, CardBody, Input, Select } from "../../components/primitives";
import { ErrorCard, Skeleton } from "../../components/states";
import { useAsync } from "../../hooks/useAsync";
import { useInstances } from "../../state/InstanceContext";
import { formatDateTime, formatRelative, titleCase, truncate } from "../../lib/format";
import { durableState, durableStateVariant } from "../../lib/status";
import { StoreDurableDrawer } from "./StoreDurableDrawer";

/** Page size for the durable browser. */
const PAGE_SIZE = 25;

/** Durable browser with filters, pagination, trace drawer, and store form. */
export function DurablesTab(): React.ReactElement {
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
                  { header: "Claim key", render: (durable) => (durable.claim_key ? <span className="mono muted" style={{ fontSize: "var(--text-2xs)" }}>{durable.claim_key}</span> : <span className="muted">-</span>) },
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
