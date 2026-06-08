import { useNavigate } from "react-router-dom";

import { api } from "../api/client";
import type { CockpitSnapshot, HealthStats } from "../api/types";
import { Gauge, MiniBars, Sparkline, StackedBar } from "../components/dataviz";
import { Badge, Button, Card, CardBody, CardHeader, KeyValue } from "../components/primitives";
import { DataTable } from "../components/DataTable";
import { StatTile } from "../components/StatTile";
import { ErrorCard, RequireInstance, Skeleton } from "../components/states";
import { useAsync } from "../hooks/useAsync";
import { useInstances } from "../state/InstanceContext";
import { formatCost, formatDateTime, formatNumber, formatRelative, titleCase } from "../lib/format";
import { runStatusVariant } from "../lib/status";

/**
 * Computes a composite 0-100 corpus health score.
 *
 * Blends average quality, 30-day freshness, and trusted claim-key ratio so a
 * single number reflects content quality, recency, and resolution confidence.
 *
 * @param health - Aggregate health stats.
 * @returns Health score from 0 to 100.
 */
function healthScore(health: HealthStats): number {
  if (health.total === 0) {
    return 0;
  }
  const quality = health.quality.average * 100;
  const freshness = (health.recency.last30 / health.total) * 100;
  const keyed = health.claimKeyLifecycle.trusted + health.claimKeyLifecycle.tentative + health.claimKeyLifecycle.unresolved;
  const trusted = keyed > 0 ? (health.claimKeyLifecycle.trusted / keyed) * 100 : 70;
  return Math.round(quality * 0.5 + freshness * 0.2 + trusted * 0.3);
}

/**
 * Ops Cockpit page: corpus health, pending work, and recent run activity.
 *
 * @returns The rendered cockpit.
 */
export function CockpitPage(): React.ReactElement {
  return (
    <RequireInstance>
      <CockpitInner />
    </RequireInstance>
  );
}

/** Cockpit content shown once an instance is confirmed selected. */
function CockpitInner(): React.ReactElement {
  const { selected } = useInstances();
  const navigate = useNavigate();
  const state = useAsync<CockpitSnapshot>(() => api.cockpit(), [selected?.record.id]);

  if (state.loading && !state.data) {
    return (
      <div className="grid grid--stats">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} height={104} />
        ))}
      </div>
    );
  }

  if (state.error) {
    return <ErrorCard error={state.error} onRetry={state.refetch} />;
  }

  const snapshot = state.data;
  if (!snapshot) {
    return <ErrorCard error={new Error("No cockpit data.")} onRetry={state.refetch} />;
  }

  const { health, recentRuns, lastRun, backlog, profile } = snapshot;
  const score = healthScore(health);
  const completedRuns = [...recentRuns].reverse();
  const actionTrend = completedRuns.map((run) => run.actionsTaken);
  const alerts = buildAlerts(snapshot);

  return (
    <div className="stack" style={{ gap: "var(--space-6)" }}>
      <div className="page-head">
        <div className="page-head__lead">
          <h2>Operations overview</h2>
          <p>Live corpus health and maintenance posture for {selected?.record.name}.</p>
        </div>
        <div className="row" style={{ gap: "var(--space-2)" }}>
          <Button variant="ghost" icon="refresh" onClick={state.refetch}>
            Refresh
          </Button>
          <Button variant="dream" icon="dream" onClick={() => navigate("/dreaming")}>
            Run dreaming
          </Button>
        </div>
      </div>

      <div className="grid grid--stats">
        <StatTile label="Durables" value={formatNumber(health.total)} icon="database" foot={<span className="muted">{Object.keys(health.byType).length} kinds</span>} />
        <StatTile
          label="Proposal backlog"
          value={formatNumber(backlog.total)}
          icon="proposals"
          accent={backlog.total > 0 ? "var(--warning)" : "var(--success)"}
          foot={
            <span className="muted">
              {backlog.eligible} eligible{backlog.oldestOpenCreatedAt ? ` \u00b7 oldest ${formatRelative(backlog.oldestOpenCreatedAt)}` : ""}
            </span>
          }
        />
        <StatTile
          label="Avg quality"
          value={`${Math.round(health.quality.average * 100)}`}
          icon="heart"
          accent="var(--info)"
          foot={<span className="muted">{health.quality.high} high · {health.quality.low} low</span>}
        />
        <StatTile
          label="Last run"
          value={lastRun ? titleCase(lastRun.status) : "None"}
          icon="dream"
          accent="var(--dream)"
          foot={<span className="muted">{lastRun ? formatRelative(lastRun.startedAt) : "no runs yet"}</span>}
          spark={actionTrend}
        />
      </div>

      <div className="grid grid--2">
        <Card>
          <CardHeader title="Corpus health" icon="heart" />
          <CardBody>
            <div className="row" style={{ gap: "var(--space-6)", alignItems: "center" }}>
              <Gauge value={score} label="health" />
              <div className="grow stack" style={{ gap: "var(--space-4)" }}>
                <div className="stack" style={{ gap: "var(--space-2)" }}>
                  <span className="section-title">Claim-key lifecycle</span>
                  <StackedBar
                    segments={[
                      { label: "Trusted", value: health.claimKeyLifecycle.trusted, color: "var(--success)" },
                      { label: "Tentative", value: health.claimKeyLifecycle.tentative, color: "var(--warning)" },
                      { label: "Unresolved", value: health.claimKeyLifecycle.unresolved, color: "var(--danger)" },
                      { label: "No key", value: health.claimKeyLifecycle.noKey, color: "var(--neutral)" },
                    ]}
                  />
                </div>
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Recency distribution" icon="clock" />
          <CardBody>
            <MiniBars
              bars={[
                { label: "Last 7 days", value: health.recency.last7, color: "var(--accent)" },
                { label: "Last 30 days", value: health.recency.last30, color: "var(--info)" },
                { label: "30-90 days", value: health.recency.d30To90, color: "var(--dream)" },
                { label: "90+ days", value: health.recency.d90Plus, color: "var(--neutral)" },
              ]}
            />
          </CardBody>
        </Card>
      </div>

      {alerts.length > 0 ? (
        <Card>
          <CardHeader title="Attention" icon="alert" actions={<Badge status="warning">{alerts.length}</Badge>} />
          <CardBody>
            <div className="stack" style={{ gap: "var(--space-3)" }}>
              {alerts.map((alert) => (
                <div key={alert.title} className="row" style={{ gap: "var(--space-3)", alignItems: "flex-start" }}>
                  <span className={`dot dot--${alert.severity}`} style={{ marginTop: 5 }} />
                  <div className="grow stack" style={{ gap: 1 }}>
                    <strong style={{ fontSize: "var(--text-sm)" }}>{alert.title}</strong>
                    <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
                      {alert.detail}
                    </span>
                  </div>
                  {alert.action ? (
                    <Button variant="ghost" size="sm" onClick={() => navigate(alert.action!.to)}>
                      {alert.action.label}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <div className="grid grid--2">
        <Card>
          <CardHeader title="Type breakdown" icon="memory" actions={<Button variant="ghost" size="sm" icon="arrow-right" onClick={() => navigate("/memory")}>Explore</Button>} />
          <CardBody>
            <MiniBars
              bars={Object.entries(health.byType)
                .sort((a, b) => b[1] - a[1])
                .map(([type, count], index) => ({ label: titleCase(type), value: count, color: `var(--viz-${(index % 6) + 1})` }))}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Active profile" icon="spark" />
          <CardBody>
            {profile.snapshot ? (
              <KeyValue
                rows={[
                  { key: "Projected", value: formatRelative(profile.snapshot.createdAt) },
                  { key: "As of", value: formatDateTime(profile.snapshot.asOf) },
                  { key: "Profile durables", value: formatNumber(profile.profileDurableCount) },
                  { key: "Directives", value: formatNumber(profile.directiveCount) },
                ]}
              />
            ) : (
              <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
                No profile has been projected yet. Run a standard or deep dreaming pass to build one.
              </span>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Recent runs"
          icon="history"
          actions={
            <div className="row" style={{ gap: "var(--space-3)" }}>
              {actionTrend.length > 1 ? <Sparkline data={actionTrend} width={120} height={26} color="var(--dream)" /> : null}
              <Button variant="ghost" size="sm" icon="arrow-right" onClick={() => navigate("/dreaming")}>
                All runs
              </Button>
            </div>
          }
        />
        <CardBody flush>
          <DataTable
            rows={recentRuns.slice(0, 6)}
            rowKey={(run) => run.id}
            empty={{ icon: "dream", title: "No runs yet", message: "Launch a dreaming run to maintain the corpus." }}
            columns={[
              { header: "Status", render: (run) => <Badge status={runStatusVariant(run.status)}>{titleCase(run.status)}</Badge> },
              { header: "Tier", render: (run) => <span className="secondary">{titleCase(run.tier)}</span> },
              { header: "Mode", render: (run) => <span className="muted">{run.dryRun ? "dry-run" : "applied"}</span> },
              { header: "Actions", align: "right", render: (run) => <span className="numeric">{run.actionsTaken}</span> },
              { header: "Cost", align: "right", render: (run) => <span className="numeric muted">{formatCost(run.estimatedCostUsd)}</span> },
              { header: "When", align: "right", render: (run) => <span className="muted">{formatRelative(run.startedAt)}</span> },
            ]}
          />
        </CardBody>
      </Card>
    </div>
  );
}

/** One cockpit attention item. */
interface Alert {
  title: string;
  detail: string;
  severity: "warning" | "danger" | "info";
  action?: { label: string; to: string };
}

/** Derives actionable attention items from the cockpit snapshot. */
function buildAlerts(snapshot: CockpitSnapshot): Alert[] {
  const alerts: Alert[] = [];

  if (snapshot.backlog.eligible > 0) {
    alerts.push({
      title: `${snapshot.backlog.eligible} proposal${snapshot.backlog.eligible === 1 ? "" : "s"} ready to apply`,
      detail: "Eligible claim-key proposals are waiting for review.",
      severity: "warning",
      action: { label: "Review", to: "/proposals" },
    });
  }

  if (snapshot.failedRuns.length > 0) {
    const recent = snapshot.failedRuns[0];
    alerts.push({
      title: `${snapshot.failedRuns.length} recent run${snapshot.failedRuns.length === 1 ? "" : "s"} failed`,
      detail: recent.error ?? "A dreaming run did not complete successfully.",
      severity: "danger",
      action: { label: "Inspect", to: "/dreaming" },
    });
  }

  if (snapshot.health.claimKeyLifecycle.unresolved > 0) {
    alerts.push({
      title: `${snapshot.health.claimKeyLifecycle.unresolved} unresolved claim keys`,
      detail: "Run reconciliation to resolve conflicting or ambiguous claim keys.",
      severity: "info",
    });
  }

  if (snapshot.recentLightApplyRunsWithoutBackup > 0) {
    alerts.push({
      title: "Light apply runs skipped backup",
      detail: `${snapshot.recentLightApplyRunsWithoutBackup} recent light apply run(s) ran without a pre-apply backup.`,
      severity: "info",
    });
  }

  return alerts;
}
