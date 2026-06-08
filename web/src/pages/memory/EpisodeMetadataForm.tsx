import { useState } from "react";

import { ApiError, api } from "../../api/client";
import type { Episode, UpdateEpisodeMetadataBody } from "../../api/types";
import { Button, Field, Input, Select } from "../../components/primitives";
import { useToast } from "../../components/Toast";

/** Form for episode metadata fields that are safe to correct in place. */
export function EpisodeMetadataForm({
  episode,
  onCancel,
  onSaved,
}: {
  episode: Episode;
  onCancel: () => void;
  onSaved: (episode: Episode) => void;
}): React.ReactElement {
  const toast = useToast();
  const [sourceRef, setSourceRef] = useState(episode.sourceRef ?? "");
  const [surface, setSurface] = useState(episode.surface ?? "");
  const [project, setProject] = useState(episode.project ?? "");
  const [userId, setUserId] = useState(episode.userId ?? "");
  const [activityLevel, setActivityLevel] = useState(episode.activityLevel ?? "");
  const [tags, setTags] = useState(episode.tags.join(", "));
  const [validFrom, setValidFrom] = useState(episode.validFrom ? episode.validFrom.slice(0, 10) : "");
  const [validTo, setValidTo] = useState(episode.validTo ? episode.validTo.slice(0, 10) : "");
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    const fields: UpdateEpisodeMetadataBody = {};
    if (sourceRef.trim() !== (episode.sourceRef ?? "")) {
      fields.sourceRef = sourceRef.trim();
    }
    if (surface.trim() !== (episode.surface ?? "")) {
      fields.surface = surface.trim();
    }
    if (project.trim() !== (episode.project ?? "")) {
      fields.project = project.trim();
    }
    if (userId.trim() !== (episode.userId ?? "")) {
      fields.userId = userId.trim();
    }
    if (activityLevel !== (episode.activityLevel ?? "")) {
      fields.activityLevel = activityLevel as UpdateEpisodeMetadataBody["activityLevel"];
    }

    const parsedTags = tags.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0);
    if (parsedTags.join("\n") !== episode.tags.join("\n")) {
      fields.tags = parsedTags;
    }

    if (validFrom.trim()) {
      fields.validFrom = new Date(`${validFrom}T00:00:00Z`).toISOString();
    } else if (episode.validFrom) {
      fields.validFrom = "";
    }
    if (validTo.trim()) {
      fields.validTo = new Date(`${validTo}T00:00:00Z`).toISOString();
    } else if (episode.validTo) {
      fields.validTo = "";
    }

    if (Object.keys(fields).length === 0) {
      toast.info("No changes", "Adjust a metadata field before saving.");
      return;
    }

    setBusy(true);
    try {
      await api.updateEpisode(episode.id, fields);
      toast.success("Episode metadata updated");
      onSaved({
        ...episode,
        sourceRef: "sourceRef" in fields ? fields.sourceRef || undefined : episode.sourceRef,
        surface: "surface" in fields ? fields.surface || undefined : episode.surface,
        project: "project" in fields ? fields.project || undefined : episode.project,
        userId: "userId" in fields ? fields.userId || undefined : episode.userId,
        activityLevel: "activityLevel" in fields ? fields.activityLevel || undefined : episode.activityLevel,
        tags: "tags" in fields ? fields.tags ?? [] : episode.tags,
        validFrom: "validFrom" in fields ? fields.validFrom || undefined : episode.validFrom,
        validTo: "validTo" in fields ? fields.validTo || undefined : episode.validTo,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      toast.error("Update failed", error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: "var(--space-4)" }}>
      <span className="section-title">Edit episode metadata</span>
      <Field label="Project">
        <Input value={project} onChange={(event) => setProject(event.target.value)} />
      </Field>
      <div className="row" style={{ gap: "var(--space-3)" }}>
        <div className="grow">
          <Field label="Activity">
            <Select value={activityLevel} onChange={(event) => setActivityLevel(event.target.value)}>
              <option value="">Unspecified</option>
              <option value="substantial">substantial</option>
              <option value="minimal">minimal</option>
              <option value="none">none</option>
            </Select>
          </Field>
        </div>
        <div className="grow">
          <Field label="Tags" hint="Comma separated">
            <Input value={tags} onChange={(event) => setTags(event.target.value)} />
          </Field>
        </div>
      </div>
      <div className="row" style={{ gap: "var(--space-3)" }}>
        <div className="grow">
          <Field label="Source ref">
            <Input value={sourceRef} onChange={(event) => setSourceRef(event.target.value)} />
          </Field>
        </div>
        <div className="grow">
          <Field label="Surface">
            <Input value={surface} onChange={(event) => setSurface(event.target.value)} />
          </Field>
        </div>
      </div>
      <Field label="User">
        <Input value={userId} onChange={(event) => setUserId(event.target.value)} />
      </Field>
      <div className="row" style={{ gap: "var(--space-3)" }}>
        <div className="grow">
          <Field label="Valid from">
            <Input type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} />
          </Field>
        </div>
        <div className="grow">
          <Field label="Valid to">
            <Input type="date" value={validTo} onChange={(event) => setValidTo(event.target.value)} />
          </Field>
        </div>
      </div>
      <div className="row" style={{ gap: "var(--space-2)", justifyContent: "flex-end" }}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" icon="check" loading={busy} onClick={() => void save()}>
          Save metadata
        </Button>
      </div>
    </div>
  );
}
