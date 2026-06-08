import { useState } from "react";

import { ApiError, api } from "../../api/client";
import { Icon } from "../Icon";
import { Button, Card, CardBody, Field, Input } from "../primitives";
import { useToast } from "../Toast";

/** Inline retire (close validity) action with an optional reason. */
export function DurableRetireAction({ id, onRetired }: { id: string; onRetired: () => void }): React.ReactElement {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const retire = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.retireDurable(id, reason.trim() || undefined);
      toast.success("Durable retired", "Its valid-time window was closed.");
      onRetired();
    } catch (error) {
      toast.error("Retire failed", error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <Button variant="danger" icon="trash" onClick={() => setConfirming(true)}>
        Retire durable
      </Button>
    );
  }

  return (
    <Card>
      <CardBody>
        <div className="stack" style={{ gap: "var(--space-3)" }}>
          <span className="row" style={{ gap: "var(--space-2)", color: "var(--warning)" }}>
            <Icon name="alert" size={16} /> Retiring closes this durable's validity. History is preserved.
          </span>
          <Field label="Reason" hint="Optional">
            <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why retire this durable?" />
          </Field>
          <div className="row" style={{ gap: "var(--space-2)", justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" icon="trash" loading={busy} onClick={() => void retire()}>
              Confirm retire
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
