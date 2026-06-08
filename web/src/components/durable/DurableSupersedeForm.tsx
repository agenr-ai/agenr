import { useState } from "react";

import { ApiError, api } from "../../api/client";
import type { Durable } from "../../api/types";
import { DurableContentFields, emptyDurableContent, toStorePayload, type DurableContentValue } from "../DurableFields";
import { Icon } from "../Icon";
import { Button } from "../primitives";
import { useToast } from "../Toast";

/** Supersede form that stores a successor durable. */
export function DurableSupersedeForm({
  durable,
  onCancel,
  onSaved,
}: {
  durable: Durable;
  onCancel: () => void;
  onSaved: () => void;
}): React.ReactElement {
  const toast = useToast();
  const [value, setValue] = useState<DurableContentValue>(() => ({
    ...emptyDurableContent(),
    type: durable.type,
    subject: durable.subject,
    content: durable.content,
    importance: String(durable.importance),
    expiry: durable.expiry,
    tags: durable.tags.join(", "),
    project: durable.project ?? "",
    claimKey: durable.claim_key ?? "",
  }));
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!value.subject.trim() || !value.content.trim()) {
      toast.error("Incomplete", "Subject and content are required.");
      return;
    }
    setBusy(true);
    try {
      await api.supersedeDurable(durable.id, toStorePayload(value));
      toast.success("Durable superseded", "A successor was stored and the predecessor closed.");
      onSaved();
    } catch (error) {
      toast.error("Supersede failed", error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: "var(--space-4)" }}>
      <span className="row" style={{ gap: "var(--space-2)", color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
        <Icon name="history" size={15} /> The current durable will be closed and replaced by this successor.
      </span>
      <DurableContentFields value={value} onChange={setValue} />
      <div className="row" style={{ gap: "var(--space-2)", justifyContent: "flex-end" }}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" icon="check" loading={busy} onClick={() => void submit()}>
          Store successor
        </Button>
      </div>
    </div>
  );
}
