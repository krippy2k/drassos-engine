import { useEffect, useState } from "react";
import { api, type HumanInteraction, type HumanTask } from "../api.ts";

export function TasksPage() {
  const [tasks, setTasks] = useState<HumanTask[]>([]);
  const [interactions, setInteractions] = useState<HumanInteraction[]>([]);
  const [selectedTask, setSelectedTask] = useState<HumanTask | null>(null);
  const [selectedInteraction, setSelectedInteraction] = useState<HumanInteraction | null>(null);
  const [body, setBody] = useState('{\n  "approved": true\n}');
  const [feedback, setFeedback] = useState("Please revise the summary.");
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    Promise.all([api.tasks(), api.interactions()])
      .then(([taskData, interactionData]) => {
        setTasks(taskData.tasks);
        setInteractions(interactionData.interactions);
        setSelectedTask((current) => taskData.tasks.find((task) => task.id === current?.id) ?? taskData.tasks[0] ?? null);
        setSelectedInteraction(
          (current) =>
            interactionData.interactions.find((item) => item.id === current?.id) ??
            interactionData.interactions[0] ??
            null,
        );
      })
      .catch((err: Error) => setError(err.message));

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, []);

  async function complete(response: unknown) {
    if (!selectedTask) {
      return;
    }
    try {
      await api.completeTask(selectedTask.id, response);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function completeInteraction(decision: unknown) {
    if (!selectedInteraction) {
      return;
    }
    try {
      await api.completeInteraction(selectedInteraction.runId, selectedInteraction.interactionId, decision);
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
          {tasks.length === 0 && interactions.length === 0 ? (
            <div className="empty">No human tasks.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {interactions.map((item) => (
                  <tr
                    key={item.id}
                    onClick={() => {
                      setSelectedInteraction(item);
                      setSelectedTask(null);
                    }}
                  >
                    <td>{item.title}</td>
                    <td>approval</td>
                    <td>
                      <span className={`badge ${item.status}`}>{item.status}</span>
                    </td>
                  </tr>
                ))}
                {tasks.map((task) => (
                  <tr
                    key={task.id}
                    onClick={() => {
                      setSelectedTask(task);
                      setSelectedInteraction(null);
                    }}
                  >
                    <td>{task.title}</td>
                    <td>task</td>
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
          {selectedInteraction ? (
            <>
              <h2>{selectedInteraction.title}</h2>
              <p className="muted">
                Run <a href={`#/runs/${selectedInteraction.runId}`}>{selectedInteraction.runId.slice(0, 8)}</a>
                {" · "}
                {selectedInteraction.interactionId}
              </p>
              {selectedInteraction.description && (
                <div className="panel">
                  <pre>{selectedInteraction.description}</pre>
                </div>
              )}
              {selectedInteraction.status === "pending" && (
                <>
                  <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} />
                  <div className="actions">
                    <button type="button" onClick={() => void completeInteraction({ outcome: "approved" })}>
                      Approve
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => void completeInteraction({ outcome: "rejected", reason: feedback })}
                    >
                      Reject
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      onClick={() =>
                        void completeInteraction({ outcome: "changes_requested", feedback })
                      }
                    >
                      Request changes
                    </button>
                  </div>
                </>
              )}
            </>
          ) : selectedTask ? (
            <>
              <h2>{selectedTask.title}</h2>
              <p className="muted">
                Run <a href={`#/runs/${selectedTask.runId}`}>{selectedTask.runId.slice(0, 8)}</a>
              </p>
              <div className="panel">
                <pre>{JSON.stringify(selectedTask.data, null, 2)}</pre>
              </div>
              {selectedTask.status === "pending" && (
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
