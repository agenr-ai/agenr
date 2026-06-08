import { useState } from "react";

import { api } from "../../api/client";
import type { Episode } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Badge, Button, Card, CardBody, Chip, EmptyState, Input } from "../../components/primitives";
import { ErrorCard, Skeleton } from "../../components/states";
import { useAsync } from "../../hooks/useAsync";
import { useInstances } from "../../state/InstanceContext";
import { formatRelative, truncate } from "../../lib/format";
import { EpisodeDrawer } from "./EpisodeDrawer";

/** Recent-episodes browser. */
export function EpisodesTab(): React.ReactElement {
  const { selected } = useInstances();
  const [project, setProject] = useState("");
  const [active, setActive] = useState<Episode | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const state = useAsync(() => api.episodes({ project: project.trim() || undefined, limit: 50 }), [selected?.record.id, project, reloadToken]);

  const reload = (): void => setReloadToken((value) => value + 1);

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

      {active ? <EpisodeDrawer episode={active} onClose={() => setActive(null)} onSaved={(episode) => { setActive(episode); reload(); }} /> : null}
    </div>
  );
}
