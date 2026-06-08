import { useState } from "react";

import type { Episode } from "../../api/types";
import { Button, Drawer, KeyValue } from "../../components/primitives";
import { formatDateTime } from "../../lib/format";
import { EpisodeMetadataForm } from "./EpisodeMetadataForm";

/** Episode detail drawer with metadata editing. */
export function EpisodeDrawer({
  episode,
  onClose,
  onSaved,
}: {
  episode: Episode;
  onClose: () => void;
  onSaved: (episode: Episode) => void;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);

  return (
    <Drawer
      title="Episode"
      subtitle={<span className="mono">{episode.id}</span>}
      onClose={onClose}
      actions={
        editing ? undefined : (
          <Button variant="ghost" size="sm" icon="edit" onClick={() => setEditing(true)}>
            Edit metadata
          </Button>
        )
      }
    >
      {editing ? (
        <EpisodeMetadataForm episode={episode} onCancel={() => setEditing(false)} onSaved={(updated) => { setEditing(false); onSaved(updated); }} />
      ) : (
        <div className="stack" style={{ gap: "var(--space-4)" }}>
          <KeyValue
            rows={[
              { key: "Source", value: episode.source },
              { key: "Source ref", value: episode.sourceRef ?? "-" },
              { key: "Surface", value: episode.surface ?? "-" },
              { key: "Project", value: episode.project ?? "-" },
              { key: "User", value: episode.userId ?? "-" },
              { key: "Started", value: formatDateTime(episode.startedAt) },
              { key: "Ended", value: episode.endedAt ? formatDateTime(episode.endedAt) : "-" },
              { key: "Messages", value: episode.messageCount != null ? String(episode.messageCount) : "-" },
              { key: "Activity", value: episode.activityLevel ?? "-" },
              { key: "Tags", value: episode.tags.length > 0 ? episode.tags.join(", ") : "-" },
              { key: "Valid from", value: episode.validFrom ? formatDateTime(episode.validFrom) : "-" },
              { key: "Valid to", value: episode.validTo ? formatDateTime(episode.validTo) : "-" },
            ]}
          />
          <div className="stack" style={{ gap: "var(--space-2)" }}>
            <span className="section-title">Summary</span>
            <div className="code-surface">{episode.summary ?? "(no summary)"}</div>
          </div>
        </div>
      )}
    </Drawer>
  );
}
