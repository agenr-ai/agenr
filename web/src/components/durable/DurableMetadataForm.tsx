import { useState } from "react";

import { ApiError, api } from "../../api/client";
import type { Durable, UpdateDurableMetadataBody } from "../../api/types";
import { EXPIRY_LEVELS } from "../DurableFields";
import { Button, Field, Input, Select } from "../primitives";
import { useToast } from "../Toast";

/** Metadata-only edit form. */
export function DurableMetadataForm({
  durable,
  onCancel,
  onSaved,
}: {
  durable: Durable;
  onCancel: () => void;
  onSaved: () => void;
}): React.ReactElement {
  const toast = useToast();
  const [importance, setImportance] = useState(String(durable.importance));
  const [expiry, setExpiry] = useState(durable.expiry);
  const [claimKey, setClaimKey] = useState(durable.claim_key ?? "");
  const [project, setProject] = useState(durable.project ?? "");
  const [validTo, setValidTo] = useState(durable.valid_to ? durable.valid_to.slice(0, 10) : "");
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    const fields: UpdateDurableMetadataBody = {};
    const importanceValue = Number(importance);
    if (Number.isFinite(importanceValue) && importanceValue !== durable.importance) {
      fields.importance = importanceValue;
    }
    if (expiry !== durable.expiry) {
      fields.expiry = expiry as UpdateDurableMetadataBody["expiry"];
    }
    if (claimKey.trim() && claimKey.trim() !== durable.claim_key) {
      fields.claimKey = claimKey.trim();
    }
    if (project.trim() !== (durable.project ?? "")) {
      fields.project = project.trim();
    }
    if (validTo.trim()) {
      fields.validTo = new Date(`${validTo}T00:00:00Z`).toISOString();
    }

    if (Object.keys(fields).length === 0) {
      toast.info("No changes", "Adjust a field before saving.");
      return;
    }

    setBusy(true);
    try {
      await api.updateDurable(durable.id, fields);
      toast.success("Metadata updated");
      onSaved();
    } catch (error) {
      toast.error("Update failed", error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: "var(--space-4)" }}>
      <span className="section-title">Edit metadata</span>
      <div className="row" style={{ gap: "var(--space-3)" }}>
        <div className="grow">
          <Field label="Importance" hint="0.0 - 1.0">
            <Input type="number" min="0" max="1" step="0.05" value={importance} onChange={(event) => setImportance(event.target.value)} />
          </Field>
        </div>
        <div className="grow">
          <Field label="Expiry">
            <Select value={expiry} onChange={(event) => setExpiry(event.target.value)}>
              {EXPIRY_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      <Field label="Claim key">
        <Input value={claimKey} onChange={(event) => setClaimKey(event.target.value)} placeholder="entity/attribute" />
      </Field>
      <div className="row" style={{ gap: "var(--space-3)" }}>
        <div className="grow">
          <Field label="Project">
            <Input value={project} onChange={(event) => setProject(event.target.value)} />
          </Field>
        </div>
        <div className="grow">
          <Field label="Valid to" hint="Sets the historical cutoff">
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
