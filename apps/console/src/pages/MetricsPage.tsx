import { useEffect, useState } from "react";
import { api, type ObservabilityMetrics } from "../api.ts";
import { formatDuration } from "../debug.ts";

function pct(value: number | null): string {
  return value == null ? "—" : formatDuration(value);
}

export function MetricsPage() {
  const [metrics, setMetrics] = useState<ObservabilityMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api
        .metrics()
        .then(setMetrics)
        .catch((err: Error) => setError(err.message));
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, []);

  if (error) {
    return <p className="error">{error}</p>;
  }
  if (!metrics) {
    return <p className="muted">Loading metrics…</p>;
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Metrics</h1>
          <p className="muted">Operational overview from recent workflow history.</p>
        </div>
      </div>
      <div className="metric-grid">
        <Metric label="Active" value={metrics.active} />
        <Metric label="Completed" value={metrics.completed} />
        <Metric label="Failed" value={metrics.failed} />
        <Metric label="Cancelled" value={metrics.cancelled} />
        <Metric label="Waiting on humans" value={metrics.waitingHuman} />
        <Metric label="Waiting on workers" value={metrics.waitingCompatibleWorkers ?? 0} />
        <Metric label="Replay attempts" value={metrics.replayAttempts ?? 0} />
        <Metric label="Replay successes" value={metrics.replaySuccesses ?? 0} />
        <Metric label="Replay divergences" value={metrics.replayDivergences ?? 0} />
        <Metric label="Success rate" value={`${Math.round(metrics.successRate * 100)}%`} />
        <Metric label="Retry rate" value={`${Math.round(metrics.retryRate * 100)}%`} />
        <Metric label="Tool failure rate" value={`${Math.round(metrics.toolFailureRate * 100)}%`} />
        <Metric label="Tokens in" value={metrics.tokenInput} />
        <Metric label="Tokens out" value={metrics.tokenOutput} />
        <Metric label="Estimated cost" value={`$${metrics.estimatedCostUsd.toFixed(4)}`} />
      </div>
        <div className="grid" style={{ marginTop: 18 }}>
        <div className="panel" style={{ padding: 16 }}>
          <h2>Workflow latency</h2>
          <p>p50 {pct(metrics.workflowLatency.p50)}</p>
          <p>p95 {pct(metrics.workflowLatency.p95)}</p>
          <p>p99 {pct(metrics.workflowLatency.p99)}</p>
        </div>
        <div className="panel" style={{ padding: 16 }}>
          <h2>Agent / tool latency</h2>
          <p>Agent p50 {pct(metrics.agentLatency.p50)} · p95 {pct(metrics.agentLatency.p95)}</p>
          <p>Tool p50 {pct(metrics.toolLatency.p50)} · p95 {pct(metrics.toolLatency.p95)}</p>
        </div>
      </div>
      {(metrics.executionsByVersion?.length || metrics.workersByVersion?.length) ? (
        <div className="grid" style={{ marginTop: 18 }}>
          <div className="panel" style={{ padding: 16 }}>
            <h2>Executions by version</h2>
            {(metrics.executionsByVersion ?? []).map((row) => (
              <p key={`${row.workflowName}@${row.version}`}>
                {row.workflowName}@{row.version} · {row.count}
              </p>
            ))}
          </div>
          <div className="panel" style={{ padding: 16 }}>
            <h2>Workers by version</h2>
            {(metrics.workersByVersion ?? []).map((row) => (
              <p key={row.version}>
                {row.version} · {row.workers}
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="panel metric-card">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
