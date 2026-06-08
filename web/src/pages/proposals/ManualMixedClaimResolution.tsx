import { useState } from "react";

import { ApiError, api } from "../../api/client";
import type { Durable, ManualMixedSettlementChoice } from "../../api/types";
import { Button, Field, Input, Select, Textarea } from "../../components/primitives";
import { useToast } from "../../components/Toast";

/** Manual settlement workflow for mixed-key groups without a safe direct target. */
export function ManualMixedClaimResolution({
  proposalId,
  durables,
  onReviewed,
}: {
  proposalId: string;
  durables: Durable[];
  onReviewed: () => void;
}): React.ReactElement {
  const toast = useToast();
  const uniqueClaimKeys = uniqueStrings(durables.flatMap((durable) => (durable.claim_key ? [durable.claim_key] : [])));
  const [choice, setChoice] = useState<ManualMixedSettlementChoice>("separate");
  const [selectedClaimKey, setSelectedClaimKey] = useState(uniqueClaimKeys[0] ?? "__custom");
  const [customClaimKey, setCustomClaimKey] = useState("");
  const [selectedRetireIds, setSelectedRetireIds] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const settle = async (): Promise<void> => {
    const trimmedNote = note.trim();
    if (trimmedNote.length === 0) {
      toast.error("Note required", "Enter a short note explaining this settlement.");
      return;
    }

    if (choice === "canonical") {
      const targetClaimKey = resolveTargetClaimKey(choice, selectedClaimKey, customClaimKey);
      if (!targetClaimKey) {
        toast.error("Claim key required", "Choose or enter a canonical claim key.");
        return;
      }
    } else if (choice === "retire" && selectedRetireIds.length === 0) {
      toast.error("Selection required", "Select at least one durable to retire.");
      return;
    }

    setBusy(true);
    try {
      await api.settleMixedProposal(proposalId, {
        choice,
        reason: trimmedNote,
        ...(choice === "canonical" ? { targetClaimKey: resolveTargetClaimKey(choice, selectedClaimKey, customClaimKey) } : {}),
        ...(choice === "retire" ? { retireDurableIds: selectedRetireIds } : {}),
      });
      toast.success("Issue settled");
      onReviewed();
    } catch (error) {
      toast.error("Resolution failed", error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleRetireId = (durableId: string): void => {
    setSelectedRetireIds((current) => (current.includes(durableId) ? current.filter((id) => id !== durableId) : [...current, durableId]));
  };

  const targetClaimKey = resolveTargetClaimKey(choice, selectedClaimKey, customClaimKey);

  return (
    <div className="manual-resolution">
      <span className="section-title">Settle flagged issue</span>
      <div className="manual-resolution__choices">
        <ResolutionOption
          active={choice === "separate"}
          title="Keep separate"
          body="Close the flag and leave the current claim keys unchanged."
          onSelect={() => setChoice("separate")}
        />
        <ResolutionOption
          active={choice === "canonical"}
          title="Use one key"
          body="Write one trusted manual claim key to every affected durable, then close the flag."
          onSelect={() => setChoice("canonical")}
        />
        <ResolutionOption
          active={choice === "retire"}
          title="Retire selected"
          body="Close duplicate or wrong durables, then close the flag."
          onSelect={() => setChoice("retire")}
        />
      </div>

      {choice === "canonical" ? (
        <div className="metadata-form__grid">
          <div className="metadata-form__field metadata-form__field--wide">
            <Field label="Canonical claim key">
              <Select value={selectedClaimKey} onChange={(event) => setSelectedClaimKey(event.target.value)}>
                {uniqueClaimKeys.map((claimKey) => (
                  <option key={claimKey} value={claimKey}>
                    {claimKey}
                  </option>
                ))}
                <option value="__custom">Custom key</option>
              </Select>
            </Field>
          </div>
          {selectedClaimKey === "__custom" ? (
            <div className="metadata-form__field metadata-form__field--wide">
              <Field label="Custom key" hint="Canonical entity/attribute format">
                <Input value={customClaimKey} placeholder="entity/attribute" onChange={(event) => setCustomClaimKey(event.target.value)} />
              </Field>
            </div>
          ) : null}
          {targetClaimKey ? <span className="hint metadata-form__field--wide">Every active affected durable will use {targetClaimKey}.</span> : null}
        </div>
      ) : null}

      {choice === "retire" ? (
        <div className="manual-resolution__retire-list">
          {durables.map((durable) => (
            <label key={durable.id} className="manual-resolution__retire-row">
              <input type="checkbox" checked={selectedRetireIds.includes(durable.id)} onChange={() => toggleRetireId(durable.id)} />
              <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                <strong>{durable.subject}</strong>
                <span className="mono muted">{durable.claim_key ?? "(no key)"}</span>
              </span>
            </label>
          ))}
        </div>
      ) : null}

      <Field label="Decision note" hint="Saved on the proposal review record.">
        <Textarea rows={3} value={note} placeholder="Why does this settle the flagged issue?" onChange={(event) => setNote(event.target.value)} />
      </Field>

      <div className="row wrap" style={{ gap: "var(--space-3)", justifyContent: "flex-end" }}>
        <Button variant="primary" icon="check" loading={busy} onClick={() => void settle()}>
          Settle issue
        </Button>
      </div>
    </div>
  );
}

function ResolutionOption({
  active,
  title,
  body,
  onSelect,
}: {
  active: boolean;
  title: string;
  body: string;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <button className={`manual-resolution__option${active ? " is-active" : ""}`} onClick={onSelect}>
      <strong>{title}</strong>
      <span>{body}</span>
    </button>
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function resolveTargetClaimKey(choice: ManualMixedSettlementChoice, selectedClaimKey: string, customClaimKey: string): string {
  if (choice !== "canonical") {
    return "";
  }
  return selectedClaimKey === "__custom" ? customClaimKey.trim() : selectedClaimKey.trim();
}
