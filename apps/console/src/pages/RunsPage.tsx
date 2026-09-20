import { useEffect, useState } from "react";
import { api, type ObservabilityMetrics, type RunSummary } from "../api.ts";
import { formatCostUsd, formatDuration } from "../debug.ts";

const REFUND_EXAMPLE = `{
  "customerId": "cust_100",
  "amount": 180,
  "reason": "damaged item",
  "sleepDuration": "10s"
}`;

const ISSUE_EXAMPLE = `{
  "issue": 42,
  "repository": "acme/widgets"
}`;

const RESTAURANT_EXAMPLE = `{
  "city": "Portland",
  "partySize": 4,
  "vegetarian": true
}`;

function defaultInput(workflow: string): string {
  if (workflow === "customer-refund") {
    return REFUND_EXAMPLE;
  }
  if (workflow === "issue-resolution") {
    return ISSUE_EXAMPLE;
  }
  if (workflow === "restaurant-research") {
    return RESTAURANT_EXAMPLE;
  }
  if (workflow === "report-approval") {
    return `{\n  "topic": "Durable human-in-the-loop agents"\n}`;
  }
  if (workflow === "multi-agent-research") {
    return `{\n  "topic": "Durable multi-agent orchestration"\n}`;
  }
  if (workflow === "observability-tour") {
    return `{\n  "topic": "workflow debugging",\n  "secretToken": "demo-secret"\n}`;
  }
  if (workflow === "order-processing") {
    return `{\n  "orderId": "ord-1",\n  "amount": 42\n}`;
  }
  return "{\n}\n";
}

export function RunsPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [workflows, setWorkflows] = useState<Array<{ name: string; version: string }>>([]);
  const [workflow, setWorkflow] = useState("customer-refund@1");
  const [filterWorkflow, setFilterWorkflow] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterAgent, setFilterAgent] = useState("");
  const [filterFailed, setFilterFailed] = useState(false);
  const [input, setInput] = useState(REFUND_EXAMPLE);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<ObservabilityMetrics | null>(null);
  const limit = 25;

  useEffect(() => {
    const load = () =>
      api
        .runs({
          workflow: filterWorkflow || undefined,
          status: filterStatus || undefined,
          agent: filterAgent || undefined,
          failed: filterFailed || undefined,
          limit,
          offset,
        })
        .then((data) => {
          setRuns(data.runs);
          setTotal(data.total);
        })
        .catch((err: Error) => setError(err.message));
    void load();
    void api.metrics().then(setMetrics).catch(() => undefined);
    void api
      .workflows()
      .then((data) => {
        const flattened = data.workflows.flatMap((item) =>
          (item.versions ?? [item.version]).map((version) => ({ name: item.name, version })),
        );
        setWorkflows(flattened);
        if (flattened[0] && !flattened.some((item) => `${item.name}@${item.version}` === workflow)) {
          setWorkflow(`${flattened[0].name}@${flattened[0].version}`);
          setInput(defaultInput(flattened[0].name));
        }
      })
      .catch((err: Error) => setError(err.message));
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [filterWorkflow, filterStatus, filterAgent, filterFailed, offset]);

  async function startRun() {
    setStarting(true);
    setError(null);
    try {
      const parsed = JSON.parse(input) as unknown;
      const at = workflow.lastIndexOf("@");
      const name = at > 0 ? workflow.slice(0, at) : workflow;
      const version = at > 0 ? workflow.slice(at + 1) : undefined;
      const run = await api.startRun(name, parsed, version);
      window.location.hash = `/runs/${run.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  const uniqueWorkflows = workflows;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Executions</h1>
          <p className="muted">Filter recent runs, then open one to inspect the graph, timeline, and history.</p>
        </div>
      </div>
      {metrics && (
        <div className="metric-strip">
          <div>
            <span className="muted">Active</span>
            <strong>{metrics.active}</strong>
          </div>
          <div>
            <span className="muted">Completed</span>
            <strong>{metrics.completed}</strong>
          </div>
          <div>
            <span className="muted">Failed</span>
            <strong>{metrics.failed}</strong>
          </div>
          <div>
            <span className="muted">Waiting on humans</span>
            <strong>{metrics.waitingHuman}</strong>
          </div>
          <div>
            <span className="muted">Waiting on workers</span>
            <strong>{metrics.waitingCompatibleWorkers ?? 0}</strong>
          </div>
          <div>
            <span className="muted">Success</span>
            <strong>{Math.round(metrics.successRate * 100)}%</strong>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <div className="start-form panel">
        <label>
          Workflow
          <select
            value={workflow}
            onChange={(event) => {
              const value = event.target.value;
              setWorkflow(value);
              const at = value.lastIndexOf("@");
              setInput(defaultInput(at > 0 ? value.slice(0, at) : value));
            }}
          >
            {(uniqueWorkflows.length > 0 ? uniqueWorkflows : [{ name: "customer-refund", version: "1" }]).map((item) => (
              <option key={`${item.name}@${item.version}`} value={`${item.name}@${item.version}`}>
                {item.name}@{item.version}
              </option>
            ))}
          </select>
        </label>
        <label>
          Input JSON
          <textarea value={input} onChange={(event) => setInput(event.target.value)} />
        </label>
        <div className="actions">
          <button type="button" disabled={starting} onClick={() => void startRun()}>
            {starting ? "Starting…" : "Start run"}
          </button>
        </div>
      </div>
      <div className="filters panel">
        <label>
          Workflow
          <select
            value={filterWorkflow}
            onChange={(event) => {
              setOffset(0);
              setFilterWorkflow(event.target.value);
            }}
          >
            <option value="">All</option>
            {uniqueWorkflows.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select
            value={filterStatus}
            onChange={(event) => {
              setOffset(0);
              setFilterStatus(event.target.value);
            }}
          >
            <option value="">All</option>
            {["PENDING", "RUNNING", "WAITING", "COMPLETED", "FAILED", "CANCELLED"].map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <label>
          Agent
          <input
            value={filterAgent}
            placeholder="agent name"
            onChange={(event) => {
              setOffset(0);
              setFilterAgent(event.target.value);
            }}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={filterFailed}
            onChange={(event) => {
              setOffset(0);
              setFilterFailed(event.target.checked);
            }}
          />
          Failures only
        </label>
      </div>
      <div className="panel">
        {runs.length === 0 ? (
          <div className="empty">No runs match these filters.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Workflow</th>
                <th>Status</th>
                <th>Current step</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} onClick={() => (window.location.hash = `/runs/${run.id}`)}>
                  <td className="mono">{run.id.slice(0, 8)}</td>
                  <td>
                    {run.workflowName}
                    {run.workflowVersion ? `@${run.workflowVersion}` : ""}
                  </td>
                  <td>
                    <span className={`badge ${run.status}`}>{run.status}</span>
                  </td>
                  <td>{run.currentStep ?? "—"}</td>
                  <td>{run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}</td>
                  <td>{formatDuration(run.durationMs)}</td>
                  <td className="mono">{formatCostUsd(run.estimatedCostUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="pager">
        <span className="muted">
          {total === 0 ? "0" : `${offset + 1}–${Math.min(offset + limit, total)}`} of {total}
        </span>
        <button className="secondary" type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
          Previous
        </button>
        <button className="secondary" type="button" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)}>
          Next
        </button>
      </div>
    </section>
  );
}
