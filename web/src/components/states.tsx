import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { useInstances } from "../state/InstanceContext";
import { ApiError } from "../api/client";
import { Button, Card, EmptyState } from "./primitives";

/**
 * Full-height centered loading indicator.
 *
 * @returns The rendered loader.
 */
export function LoadingBlock(): React.ReactElement {
  return (
    <div className="center-screen">
      <span className="spinner" style={{ width: 26, height: 26 }} />
    </div>
  );
}

/**
 * Skeleton placeholder block sized by height.
 *
 * @param props - Optional pixel height.
 * @returns The rendered skeleton.
 */
export function Skeleton({ height = 120 }: { height?: number }): React.ReactElement {
  return <div className="skeleton" style={{ height }} />;
}

/**
 * Error panel that surfaces an API failure with a retry action.
 *
 * @param props - The error and an optional retry handler.
 * @returns The rendered error panel.
 */
export function ErrorCard({ error, onRetry }: { error: Error; onRetry?: () => void }): React.ReactElement {
  const message = error instanceof ApiError ? `${error.message}` : error.message;
  const detail = error instanceof ApiError && error.details ? error.details.map((issue) => `${issue.path}: ${issue.message}`).join("\n") : null;
  return (
    <Card>
      <EmptyState
        icon="alert"
        title="Something went wrong"
        message={
          <span className="stack" style={{ gap: "var(--space-2)", alignItems: "center" }}>
            <span>{message}</span>
            {detail ? <code style={{ fontSize: "var(--text-xs)", whiteSpace: "pre-wrap" }}>{detail}</code> : null}
          </span>
        }
        action={onRetry ? <Button variant="ghost" icon="refresh" onClick={onRetry}>Retry</Button> : undefined}
      />
    </Card>
  );
}

/**
 * Gates content behind a selected, database-backed instance.
 *
 * Renders a guiding empty state when no instance is selected or the selected
 * instance has no database yet, so pages never make doomed API calls.
 *
 * @param props - The protected content.
 * @returns The content or a guard placeholder.
 */
export function RequireInstance({ children }: { children: ReactNode }): React.ReactElement {
  const { selected, loading } = useInstances();
  const navigate = useNavigate();

  if (loading) {
    return <LoadingBlock />;
  }

  if (!selected) {
    return (
      <Card>
        <EmptyState
          icon="database"
          title="No instance selected"
          message="Register a local agenr instance to start operating on its memory corpus."
          action={<Button variant="primary" icon="plus" onClick={() => navigate("/settings")}>Add an instance</Button>}
        />
      </Card>
    );
  }

  if (selected.error) {
    return (
      <Card>
        <EmptyState icon="alert" title={`Instance "${selected.record.name}" failed to resolve`} message={selected.error} />
      </Card>
    );
  }

  if (!selected.dbExists) {
    return (
      <Card>
        <EmptyState
          icon="database"
          title="Database not initialized"
          message={`No database found at ${selected.dbPath ?? "the configured path"}. Run "agenr setup" or ingest content for this instance first.`}
        />
      </Card>
    );
  }

  return <>{children}</>;
}
