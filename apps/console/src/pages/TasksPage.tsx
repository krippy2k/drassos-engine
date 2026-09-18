import { useEffect, useState } from "react";
import { api, type HumanTask } from "../api.ts";

export function TasksPage() {
  const [tasks, setTasks] = useState<HumanTask[]>([]);
  const [selected, setSelected] = useState<HumanTask | null>(null);
  const [body, setBody] = useState('{\n  "approved": true\n}');
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .tasks()
      .then((data) => {
        setTasks(data.tasks);
        setSelected((current) => data.tasks.find((task) => task.id === current?.id) ?? data.tasks[0] ?? null);
      })
      .catch((err: Error) => setError(err.message));

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, []);

  async function complete(response: unknown) {
    if (!selected) {
      return;
    }
    try {
      await api.completeTask(selected.id, response);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Human tasks</h1>
          <p className="muted">Complete waiting work to resume a workflow.</p>
        </div>
      </div>
      {error && <p className="muted">{error}</p>}
      <div className="grid">
        <div className="panel">
          {tasks.length === 0 ? (
            <div className="empty">No human tasks.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Assignee</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id} onClick={() => setSelected(task)}>
                    <td>{task.title}</td>
                    <td>{task.assignedTo ?? "—"}</td>
                    <td>
                      <span className={`badge ${task.status}`}>{task.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          {selected ? (
            <>
              <h2>{selected.title}</h2>
              <p className="muted">
                Run <a href={`#/runs/${selected.runId}`}>{selected.runId.slice(0, 8)}</a>
              </p>
              <div className="panel">
                <pre>{JSON.stringify(selected.data, null, 2)}</pre>
              </div>
              {selected.status === "pending" && (
                <>
                  <textarea value={body} onChange={(event) => setBody(event.target.value)} />
                  <div className="actions">
                    <button type="button" onClick={() => void complete({ approved: true })}>
                      Approve
                    </button>
                    <button className="secondary" type="button" onClick={() => void complete({ approved: false })}>
                      Reject
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => void complete(JSON.parse(body) as unknown)}
                    >
                      Submit JSON
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            <p className="muted">Select a task.</p>
          )}
        </div>
      </div>
    </section>
  );
}
