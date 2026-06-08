import { useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { oneDark } from "@codemirror/theme-one-dark";

import { ApiError, api } from "../api/client";
import type { GitWorktreeStatus, ProcedureSaveResult, ProcedureSyncExecutionTotals, ProcedureValidation, ProcedureWorkspace } from "../api/types";
import { Icon } from "../components/Icon";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState } from "../components/primitives";
import { ErrorCard, RequireInstance, Skeleton } from "../components/states";
import { useToast } from "../components/Toast";
import { useAsync } from "../hooks/useAsync";
import { useInstances } from "../state/InstanceContext";

/** Starter YAML inserted when creating a new procedure file. */
const TEMPLATE = `procedure_key: namespace/short-key
title: Human readable title
goal: One sentence describing the outcome this procedure achieves.
when_to_use:
  - Situations where this procedure applies
when_not_to_use:
  - Situations where it does not apply
prerequisites:
  - What must be true before starting
steps:
  - kind: run_command
    description: Describe the first step
verification:
  - How to confirm success
failure_modes:
  - What can go wrong and how to recover
sources:
  - kind: manual
    locator: authored-in-console
`;

/**
 * Procedure Editor page: edit and sync repo-authored procedure YAML.
 *
 * @returns The rendered editor.
 */
export function ProceduresPage(): React.ReactElement {
  return (
    <RequireInstance>
      <ProcedureEditorInner />
    </RequireInstance>
  );
}

/** Editor content shown once an instance is confirmed selected. */
function ProcedureEditorInner(): React.ReactElement {
  const { selected } = useInstances();
  const toast = useToast();
  const workspace = useAsync<ProcedureWorkspace>(() => api.procedureWorkspace(), [selected?.record.id]);

  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [validation, setValidation] = useState<ProcedureValidation | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastSave, setLastSave] = useState<ProcedureSaveResult | null>(null);
  const debounce = useRef<number | null>(null);

  const dirty = content !== savedContent;

  const openFile = async (relativePath: string): Promise<void> => {
    setActivePath(relativePath);
    setLoadingDoc(true);
    setLastSave(null);
    try {
      const document = await api.procedureDocument(relativePath);
      setContent(document.content);
      setSavedContent(document.content);
      setValidation(document.validation);
    } catch (error) {
      toast.error("Could not open file", error instanceof ApiError ? error.message : String(error));
    } finally {
      setLoadingDoc(false);
    }
  };

  const createFile = (): void => {
    const name = window.prompt("New procedure file path (relative, .yaml):", "new-procedure.yaml");
    if (!name) {
      return;
    }
    const relativePath = name.endsWith(".yaml") || name.endsWith(".yml") ? name : `${name}.yaml`;
    setActivePath(relativePath);
    setContent(TEMPLATE);
    setSavedContent("");
    setValidation(null);
    setLastSave(null);
  };

  // Debounced server-side validation as the operator types.
  useEffect(() => {
    if (activePath === null) {
      return;
    }
    if (debounce.current) {
      window.clearTimeout(debounce.current);
    }
    debounce.current = window.setTimeout(() => {
      api
        .validateProcedure(content, activePath)
        .then(setValidation)
        .catch(() => undefined);
    }, 600);
    return () => {
      if (debounce.current) {
        window.clearTimeout(debounce.current);
      }
    };
  }, [content, activePath]);

  const save = async (): Promise<void> => {
    if (!activePath) {
      return;
    }
    if (validation && !validation.valid) {
      toast.error("Cannot save", "Resolve validation errors before saving.");
      return;
    }
    setSaving(true);
    try {
      const result = await api.saveProcedure({ relativePath: activePath, content });
      setSavedContent(content);
      setLastSave(result);
      setValidation(result.validation);
      toast.success("Saved and synced", summarizePlan(result));
      await workspace.refetch();
    } catch (error) {
      toast.error("Save failed", error instanceof ApiError ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  if (workspace.loading && !workspace.data) {
    return <Skeleton height={360} />;
  }

  if (workspace.error) {
    const message = workspace.error instanceof ApiError && workspace.error.code === "conflict" ? workspace.error.message : undefined;
    if (message) {
      return (
        <Card>
          <EmptyState
            icon="procedures"
            title="No procedures directory configured"
            message="Set a procedures directory for this instance in Instance Settings to author and sync procedure YAML."
          />
        </Card>
      );
    }
    return <ErrorCard error={workspace.error} onRetry={workspace.refetch} />;
  }

  const files = workspace.data?.files ?? [];

  return (
    <div className="stack" style={{ gap: "var(--space-5)" }}>
      <div className="page-head">
        <div className="page-head__lead">
          <h2>Procedure editor</h2>
          <p>Author procedure YAML and sync it into the corpus. Saving writes the file and runs a procedure sync.</p>
        </div>
        <Button variant="ghost" icon="refresh" onClick={workspace.refetch}>
          Refresh
        </Button>
      </div>

      {workspace.data ? <GitBanner git={workspace.data.git} directory={workspace.data.directory} /> : null}

      <div className="editor-grid">
        <Card>
          <CardHeader
            title={`Files (${files.length})`}
            icon="file"
            actions={<Button variant="ghost" size="sm" icon="plus" onClick={createFile} aria-label="New file" />}
          />
          <CardBody flush>
            <div className="file-list" style={{ padding: "var(--space-2)" }}>
              {files.length === 0 ? (
                <span className="muted" style={{ padding: "var(--space-3)", fontSize: "var(--text-sm)" }}>
                  No YAML files found.
                </span>
              ) : (
                files.map((file) => (
                  <div key={file.relativePath} className={`file-item${file.relativePath === activePath ? " is-active" : ""}`} onClick={() => void openFile(file.relativePath)}>
                    <Icon name="file" size={14} />
                    <span className="truncate grow">{file.relativePath}</span>
                    {file.relativePath === activePath && dirty ? <span className="file-item__dirty" /> : null}
                  </div>
                ))
              )}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={activePath ? <span className="mono">{activePath}</span> : "Editor"}
            icon="edit"
            actions={
              activePath ? (
                <div className="row" style={{ gap: "var(--space-2)" }}>
                  <ValidationBadge validation={validation} dirty={dirty} />
                  <Button variant="primary" size="sm" icon="check" loading={saving} disabled={!dirty || (validation ? !validation.valid : false)} onClick={() => void save()}>
                    Save & sync
                  </Button>
                </div>
              ) : undefined
            }
          />
          <CardBody flush>
            {activePath === null ? (
              <EmptyState icon="edit" title="Select a file" message="Choose a procedure on the left or create a new one to begin editing." />
            ) : loadingDoc ? (
              <div style={{ padding: "var(--space-5)" }}>
                <Skeleton height={300} />
              </div>
            ) : (
              <div className="cm-shell">
                <CodeMirror value={content} height="460px" theme={oneDark} extensions={[yaml()]} onChange={(value) => setContent(value)} />
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {validation && !validation.valid ? (
        <Card>
          <CardBody>
            <div className="row" style={{ gap: "var(--space-2)", color: "var(--danger)", alignItems: "flex-start" }}>
              <Icon name="alert" size={16} />
              <div className="stack" style={{ gap: 2 }}>
                <strong style={{ fontSize: "var(--text-sm)" }}>Validation error</strong>
                <span className="secondary" style={{ fontSize: "var(--text-xs)" }}>{validation.error}</span>
              </div>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {lastSave ? <SyncResult result={lastSave} /> : null}
    </div>
  );
}

/** Git worktree status banner for the procedures directory. */
function GitBanner({ git, directory }: { git: GitWorktreeStatus; directory: string }): React.ReactElement {
  if (!git.isRepository) {
    return (
      <Card>
        <CardBody>
          <div className="row" style={{ gap: "var(--space-3)" }}>
            <Icon name="branch" size={16} />
            <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
              <span className="mono">{directory}</span> is not a git repository. Edits will not be version controlled.
            </span>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody>
        <div className="spread" style={{ gap: "var(--space-3)" }}>
          <div className="row" style={{ gap: "var(--space-3)" }}>
            <Icon name="branch" size={16} />
            <span className="row" style={{ gap: "var(--space-2)" }}>
              <span className="mono" style={{ fontSize: "var(--text-sm)" }}>{git.branch ?? "detached"}</span>
              {git.isDirty ? <Badge status="warning">{git.changedFiles.length} uncommitted</Badge> : <Badge status="success">clean</Badge>}
            </span>
          </div>
          {git.isDirty ? (
            <span className="muted truncate" style={{ fontSize: "var(--text-xs)", maxWidth: 420 }}>
              {git.changedFiles.slice(0, 4).map((file) => file.path).join(", ")}
              {git.changedFiles.length > 4 ? ` +${git.changedFiles.length - 4} more` : ""}
            </span>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

/** Inline validation status badge for the editor header. */
function ValidationBadge({ validation, dirty }: { validation: ProcedureValidation | null; dirty: boolean }): React.ReactElement | null {
  if (!validation) {
    return dirty ? <Badge status="neutral">unsaved</Badge> : null;
  }
  return validation.valid ? <Badge status="success">valid</Badge> : <Badge status="danger">invalid</Badge>;
}

/** Sync plan result summary after a save. */
function SyncResult({ result }: { result: ProcedureSaveResult }): React.ReactElement {
  const totals = result.plan.totals;
  return (
    <Card>
      <CardHeader title="Last sync" icon="refresh" />
      <CardBody>
        <div className="row wrap" style={{ gap: "var(--space-2)" }}>
          <Badge status="success">{totals.create} created</Badge>
          <Badge status="info">{totals.updateSourceOnly + totals.supersede} updated</Badge>
          <Badge status="neutral">{totals.unchanged} unchanged</Badge>
          {totals.invalid > 0 ? <Badge status="danger">{totals.invalid} invalid</Badge> : null}
          {result.execution ? <Badge status="accent">{countApplied(result.execution.totals)} applied</Badge> : null}
        </div>
      </CardBody>
    </Card>
  );
}

/** Builds a short toast summary from a save result. */
function summarizePlan(result: ProcedureSaveResult): string {
  const totals = result.plan.totals;
  return `${totals.create} created, ${totals.updateSourceOnly + totals.supersede} updated, ${totals.unchanged} unchanged.`;
}

/** Counts sync execution items that wrote or reused a valid procedure row. */
function countApplied(totals: ProcedureSyncExecutionTotals): number {
  return totals.created + totals.updatedSourceOnly + totals.superseded + totals.unchanged;
}
