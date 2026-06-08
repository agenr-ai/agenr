import type { StoreDurableBody } from "../api/types";
import { Field, Input, Select, Textarea } from "./primitives";

/** Editable content fields for storing or superseding a durable. */
export interface DurableContentValue {
  type: string;
  subject: string;
  content: string;
  importance: string;
  expiry: string;
  tags: string;
  project: string;
  claimKey: string;
}

/** Supported durable kinds for the type selector. */
export const DURABLE_TYPES = ["fact", "decision", "preference", "lesson", "relationship", "milestone", "directive"];

/** Supported expiry tiers for the expiry selector. */
export const EXPIRY_LEVELS = ["core", "permanent", "temporary"];

/** Returns a blank content value seeded with sensible defaults. */
export function emptyDurableContent(): DurableContentValue {
  return { type: "fact", subject: "", content: "", importance: "0.6", expiry: "permanent", tags: "", project: "", claimKey: "" };
}

/**
 * Builds the API store payload from edited content fields.
 *
 * @param value - Current form values.
 * @returns A JSON payload for the store or supersede endpoint.
 */
export function toStorePayload(value: DurableContentValue): StoreDurableBody {
  const tags = value.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  const importance = Number(value.importance);
  return {
    type: value.type as StoreDurableBody["type"],
    subject: value.subject.trim(),
    content: value.content.trim(),
    ...(Number.isFinite(importance) ? { importance } : {}),
    expiry: value.expiry as StoreDurableBody["expiry"],
    ...(tags.length > 0 ? { tags } : {}),
    ...(value.project.trim() ? { project: value.project.trim() } : {}),
    ...(value.claimKey.trim() ? { claimKey: value.claimKey.trim() } : {}),
  };
}

/**
 * Controlled field set for durable content (type, subject, body, metadata).
 *
 * @param props - Current value and a change handler.
 * @returns The rendered fields.
 */
export function DurableContentFields({ value, onChange }: { value: DurableContentValue; onChange: (next: DurableContentValue) => void }): React.ReactElement {
  const set = <K extends keyof DurableContentValue>(key: K, next: string): void => onChange({ ...value, [key]: next });

  return (
    <div className="stack" style={{ gap: "var(--space-4)" }}>
      <div className="row" style={{ gap: "var(--space-3)" }}>
        <div style={{ flex: "0 0 160px" }}>
          <Field label="Type">
            <Select value={value.type} onChange={(event) => set("type", event.target.value)}>
              {DURABLE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grow">
          <Field label="Subject">
            <Input value={value.subject} placeholder="Short canonical subject" onChange={(event) => set("subject", event.target.value)} />
          </Field>
        </div>
      </div>

      <Field label="Content">
        <Textarea rows={5} value={value.content} placeholder="The durable knowledge to store" onChange={(event) => set("content", event.target.value)} />
      </Field>

      <div className="row" style={{ gap: "var(--space-3)" }}>
        <div className="grow">
          <Field label="Importance" hint="0.0 - 1.0">
            <Input type="number" min="0" max="1" step="0.05" value={value.importance} onChange={(event) => set("importance", event.target.value)} />
          </Field>
        </div>
        <div className="grow">
          <Field label="Expiry">
            <Select value={value.expiry} onChange={(event) => set("expiry", event.target.value)}>
              {EXPIRY_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      <div className="row" style={{ gap: "var(--space-3)" }}>
        <div className="grow">
          <Field label="Project" hint="Optional scope">
            <Input value={value.project} onChange={(event) => set("project", event.target.value)} />
          </Field>
        </div>
        <div className="grow">
          <Field label="Tags" hint="Comma separated">
            <Input value={value.tags} placeholder="auth, billing" onChange={(event) => set("tags", event.target.value)} />
          </Field>
        </div>
      </div>

      <Field label="Claim key" hint="Optional. Canonical entity/attribute form.">
        <Input value={value.claimKey} placeholder="user.alice/preferences.editor" onChange={(event) => set("claimKey", event.target.value)} />
      </Field>
    </div>
  );
}
