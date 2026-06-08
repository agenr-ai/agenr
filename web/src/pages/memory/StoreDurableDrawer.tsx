import { useState } from "react";

import { ApiError, api } from "../../api/client";
import { DurableContentFields, emptyDurableContent, toStorePayload, type DurableContentValue } from "../../components/DurableFields";
import { Button, Drawer } from "../../components/primitives";
import { useToast } from "../../components/Toast";

/** Drawer form for storing a brand-new durable. */
export function StoreDurableDrawer({ onClose, onStored }: { onClose: () => void; onStored: () => void }): React.ReactElement {
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
