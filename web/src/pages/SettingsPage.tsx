import { useState } from "react";

import { ApiError } from "../api/client";
import { Icon } from "../components/Icon";
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, KeyValue, StatusDot } from "../components/primitives";
import { useToast } from "../components/Toast";
import { useInstances } from "../state/InstanceContext";
import { formatRelative } from "../lib/format";

/**
 * Instance Settings page: register, select, and remove local instances.
 *
 * @returns The rendered settings page.
 */
export function SettingsPage(): React.ReactElement {
  const { instances, selected, register, select, remove } = useInstances();
  const toast = useToast();

  const [name, setName] = useState("");
  const [dbPath, setDbPath] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [proceduresDir, setProceduresDir] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (name.trim().length === 0) {
      toast.error("Name required", "Give the instance a display name.");
      return;
    }
    setBusy(true);
    try {
      await register({
        name: name.trim(),
        dbPath: dbPath.trim() || undefined,
        configPath: configPath.trim() || undefined,
        proceduresDir: proceduresDir.trim() || undefined,
      });
      toast.success("Instance registered", `"${name.trim()}" is now selected.`);
      setName("");
      setDbPath("");
      setConfigPath("");
      setProceduresDir("");
    } catch (error) {
      toast.error("Could not register", error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (id: string, displayName: string): Promise<void> => {
    if (!window.confirm(`Remove instance "${displayName}"? This only removes the console reference, not any data.`)) {
      return;
    }
    try {
      await remove(id);
      toast.info("Instance removed");
    } catch (error) {
      toast.error("Could not remove", error instanceof ApiError ? error.message : String(error));
    }
  };

  return (
    <div className="stack" style={{ gap: "var(--space-6)" }}>
      <div className="page-head">
        <div className="page-head__lead">
          <h2>Instance settings</h2>
          <p>Register the local agenr databases this console operates on. References are stored locally; no database content is copied.</p>
        </div>
      </div>

      <Card>
        <CardBody>
          <div className="row" style={{ gap: "var(--space-3)", alignItems: "flex-start" }}>
            <Icon name="alert" size={16} />
            <span className="secondary" style={{ fontSize: "var(--text-sm)" }}>
              This console binds to loopback only and has full write authority over the selected instance. Do not expose it beyond localhost.
            </span>
          </div>
        </CardBody>
      </Card>

      <div className="grid grid--2">
        <Card>
          <CardHeader title="Registered instances" icon="database" actions={<Badge status="neutral">{instances.length}</Badge>} />
          <CardBody flush>
            {instances.length === 0 ? (
              <div style={{ padding: "var(--space-5)" }}>
                <span className="muted" style={{ fontSize: "var(--text-sm)" }}>No instances yet. Add one using the form.</span>
              </div>
            ) : (
              <div className="stack" style={{ padding: "var(--space-3)", gap: "var(--space-3)" }}>
                {instances.map((instance) => {
                  const isSelected = instance.record.id === selected?.record.id;
                  return (
                    <div key={instance.record.id} className="card" style={{ padding: "var(--space-4)", borderColor: isSelected ? "var(--accent-dim)" : undefined }}>
                      <div className="spread" style={{ gap: "var(--space-3)", alignItems: "flex-start" }}>
                        <div className="grow stack" style={{ gap: "var(--space-3)", minWidth: 0 }}>
                          <div className="row" style={{ gap: "var(--space-2)" }}>
                            <StatusDot status={instance.error ? "danger" : instance.dbExists ? "success" : "warning"} />
                            <strong>{instance.record.name}</strong>
                            {isSelected ? <Badge status="accent">selected</Badge> : null}
                            {instance.hasProceduresDir ? <Badge status="info">procedures</Badge> : null}
                          </div>
                          <KeyValue
                            rows={[
                              { key: "Database", value: <span className="mono" style={{ fontSize: "var(--text-xs)" }}>{instance.dbPath ?? "unresolved"}</span> },
                              { key: "Config", value: <span className="mono" style={{ fontSize: "var(--text-xs)" }}>{instance.record.configPath ?? "default"}</span> },
                              ...(instance.record.proceduresDir ? [{ key: "Procedures", value: <span className="mono" style={{ fontSize: "var(--text-xs)" }}>{instance.record.proceduresDir}</span> }] : []),
                              { key: "Added", value: formatRelative(instance.record.createdAt) },
                            ]}
                          />
                          {instance.error ? (
                            <span className="row" style={{ gap: 6, color: "var(--danger)", fontSize: "var(--text-xs)" }}>
                              <Icon name="alert" size={13} /> {instance.error}
                            </span>
                          ) : !instance.dbExists ? (
                            <span className="row" style={{ gap: 6, color: "var(--warning)", fontSize: "var(--text-xs)" }}>
                              <Icon name="alert" size={13} /> Database file not found yet.
                            </span>
                          ) : null}
                        </div>
                        <div className="stack" style={{ gap: "var(--space-2)", flex: "none" }}>
                          <Button variant={isSelected ? "subtle" : "primary"} size="sm" disabled={isSelected} onClick={() => void select(instance.record.id)}>
                            {isSelected ? "Active" : "Select"}
                          </Button>
                          <Button variant="ghost" size="sm" icon="trash" onClick={() => void onRemove(instance.record.id, instance.record.name)}>
                            Remove
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Add instance" icon="plus" />
          <CardBody>
            <div className="stack" style={{ gap: "var(--space-4)" }}>
              <Field label="Display name">
                <Input value={name} placeholder="Production sandbox" onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field label="Database path" hint="Optional. Defaults to the resolved config database.">
                <Input value={dbPath} placeholder="~/.agenr/knowledge.db" onChange={(event) => setDbPath(event.target.value)} />
              </Field>
              <Field label="Config path" hint="Optional. Defaults to the standard agenr config.">
                <Input value={configPath} placeholder="~/.agenr/config.json" onChange={(event) => setConfigPath(event.target.value)} />
              </Field>
              <Field label="Procedures directory" hint="Optional. Enables the procedure editor.">
                <Input value={proceduresDir} placeholder="~/code/project/.agenr/procedures" onChange={(event) => setProceduresDir(event.target.value)} />
              </Field>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <Button variant="primary" icon="plus" loading={busy} onClick={() => void submit()}>
                  Register & select
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
