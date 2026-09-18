import { useEffect, useState } from "react";
import { api, type RunSummary } from "../api.ts";

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
  return "{\n}\n";
}

function duration(run: RunSummary): string {
  if (!run.startedAt) {
    return "—";
  }
  const end = run.completedAt ? new Date(run.completedAt).getTime() : Date.now();
  const ms = end - new Date(run.startedAt).getTime();
  if (ms < 1000) {
    return `${ms} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  return `${Math.round(ms / 60_000)} m`;
}

export function RunsPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [workflows, setWorkflows] = useState<Array<{ name: string; version: string }>>([]);
  const [workflow, setWorkflow] = useState("customer-refund");
  const [input, setInput] = useState(REFUND_EXAMPLE);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api
        .runs()
        .then((data) => setRuns(data.runs))
        .catch((err: Error) => setError(err.message));
    void load();
    void api
      .workflows()
      .then((data) => {
        setWorkflows(data.workflows);
        if (data.workflows[0] && !data.workflows.some((item) => item.name === workflow)) {
          setWorkflow(data.workflows[0].name);
          setInput(defaultInput(data.workflows[0].name));
        }
      })
      .catch((err: Error) => setError(err.message));
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, []);

  async function startRun() {
    setStarting(true);
    setError(null);
    try {
      const parsed = JSON.parse(input) as unknown;
      const run = await api.startRun(workflow, parsed);
      window.location.hash = `/runs/${run.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Workflow runs</h1>
          <p className="muted">Start a run, then inspect its durable history.</p>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="start-form panel">
        <label>
          Workflow
          <select
            value={workflow}
            onChange={(event) => {
              const name = event.target.value;
              setWorkflow(name);
              setInput(defaultInput(name));
            }}
          >
        {(workflows.length > 0
          ? [...new Map(workflows.map((item) => [item.name, item])).values()]
          : [{ name: workflow, version: "1" }]
        ).map((item) => (
            <option key={`${item.name}@${item.version}`} value={item.name}>
              {item.name} v{item.version}
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
      <div className="panel">
        {runs.length === 0 ? (
          <div className="empty">No runs yet. Start one above.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Workflow</th>
                <th>Status</th>
                <th>Started</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} onClick={() => (window.location.hash = `/runs/${run.id}`)}>
                  <td className="mono">{run.id.slice(0, 8)}</td>
                  <td>{run.workflowName}</td>
                  <td>
                    <span className={`badge ${run.status}`}>{run.status}</span>
                  </td>
                  <td>{run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}</td>
                  <td>{duration(run)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
