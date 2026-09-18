import { useEffect, useMemo, useState } from "react";
import {
  api,
  type AgentRunDetail,
  type ModelCall,
  type RunDetail,
  type ToolCall,
} from "../api.ts";

function dotClass(status: string): string {
  if (status === "COMPLETED" || status === "fired" || status === "completed") {
    return "done";
  }
  if (
    status === "WAITING" ||
    status === "WAITING_FOR_TOOL" ||
    status === "WAITING_FOR_HUMAN" ||
    status === "pending" ||
    status === "RUNNING"
  ) {
    return "wait";
  }
  if (status === "FAILED" || status === "CANCELLED" || status === "TIMED_OUT") {
    return "fail";
  }
  return "todo";
}

function durationMs(start?: string | null, end?: string | null): string {
  if (!start) {
    return "";
  }
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

export function RunDetailPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eventType, setEventType] = useState("refund.confirmed");
  const [eventData, setEventData] = useState('{\n  "ok": true\n}');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api
        .run(id)
        .then(setDetail)
        .catch((err: Error) => setError(err.message));
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [id]);

  const selectedAgent = useMemo(
    () => detail?.agentRuns?.find((agent) => agent.id === selectedAgentId) ?? null,
    [detail, selectedAgentId],
  );
  const selectedTool = useMemo(
    () => detail?.toolCalls?.find((tool) => tool.id === selectedToolId) ?? null,
    [detail, selectedToolId],
  );
  const selectedModel = useMemo(
    () => detail?.modelCalls?.find((call) => call.id === selectedModelId) ?? null,
    [detail, selectedModelId],
  );

  if (error) {
    return <p className="muted">{error}</p>;
  }
  if (!detail) {
    return <p className="muted">Loading run…</p>;
  }

  const { run, steps, history, tasks, timers, events, tools, agentRuns = [], children = [], parent } = detail;

  async function sendEvent() {
    setError(null);
    try {
      const data = JSON.parse(eventData) as unknown;
      await api.deliverEvent(id, eventType, data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <p className="muted">
            <a href="#/">Runs</a>
            {parent ? (
              <>
                {" / "}
                <a href={`#/runs/${parent.id}`}>{parent.workflowName}</a>
              </>
            ) : null}
            {" / "}
            {run.workflowName}
          </p>
          <h1>{run.workflowName}</h1>
        </div>
        <span className={`badge ${run.status}`}>{run.status}</span>
      </div>
      <div className="grid">
        <div className="panel">
          <ul className="timeline">
            {steps.length === 0 && <li className="muted">No durable operations yet.</li>}
            {steps.map((step) => {
              const agentsForStep = agentRuns.filter((agent) => agent.stepRunId === step.id);
              const childMatches = children.filter(
                (item) => step.type === "child" && (step.name === `child:${item.workflowName}` || step.name.endsWith(item.workflowName)),
              );
              return (
                <li key={step.id}>
                  <span className={`dot ${dotClass(step.status)}`} />
                  <div>
                    <strong>{step.name}</strong>
                    <div className="muted">
                      {step.type} · {step.status}
                      {step.attempt > 1 ? ` · attempt ${step.attempt}` : ""}
                      {step.startedAt ? ` · ${durationMs(step.startedAt, step.completedAt)}` : ""}
                      {step.error ? ` · ${step.error.message}` : ""}
                    </div>
                    {step.type === "child" && <ChildLinks children={childMatches} />}
                    {agentsForStep.map((agent) => (
                      <AgentBranch
                        key={agent.id}
                        agent={agent}
                        onSelectAgent={setSelectedAgentId}
                        onSelectTool={setSelectedToolId}
                        onSelectModel={setSelectedModelId}
                      />
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <dl className="panel meta" style={{ padding: 16 }}>
          <dt>Run ID</dt>
          <dd className="mono">{run.id}</dd>
          <dt>Version</dt>
          <dd>{run.workflowVersion ?? "1"}</dd>
          <dt>Started</dt>
          <dd>{run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}</dd>
          <dt>Duration</dt>
          <dd>{durationMs(run.startedAt, run.completedAt) || "—"}</dd>
          <dt>Human tasks</dt>
          <dd>{tasks.length}</dd>
          <dt>Timers</dt>
          <dd>{timers.length}</dd>
          <dt>Events</dt>
          <dd>{events.length}</dd>
          <dt>Tool calls</dt>
          <dd>{detail.toolCalls?.length ?? tools.length}</dd>
          <dt>Agent runs</dt>
          <dd>{agentRuns.length}</dd>
          {parent && (
            <>
              <dt>Parent</dt>
              <dd>
                <a href={`#/runs/${parent.id}`}>{parent.workflowName}</a>
              </dd>
            </>
          )}
        </dl>
      </div>
      {children.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <h2>Child workflows</h2>
          <div className="panel">
            <ul className="timeline">
              {children.map((child) => (
                <li key={child.id}>
                  <span className={`dot ${dotClass(child.status)}`} />
                  <div>
                    <a href={`#/runs/${child.id}`}>
                      <strong>{child.workflowName}</strong>
                    </a>
                    <div className="muted">
                      {child.status} · v{child.workflowVersion ?? "1"} · {child.id.slice(0, 8)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {(selectedAgent || selectedTool || selectedModel) && (
        <div className="grid" style={{ marginTop: 18 }}>
          {selectedAgent && <AgentPanel agent={selectedAgent} />}
          {selectedModel && <ModelPanel call={selectedModel} />}
          {selectedTool && <ToolPanel call={selectedTool} />}
        </div>
      )}
      <div className="grid" style={{ marginTop: 18 }}>
        <div>
          <h2>Input / output</h2>
          <div className="panel">
            <pre>{JSON.stringify({ input: run.input, output: run.output, error: run.error }, null, 2)}</pre>
          </div>
        </div>
        <div>
          <h2>History</h2>
          <div className="panel">
            <pre>
              {history
                .map((event) => `${new Date(event.timestamp).toISOString().slice(11, 19)}  ${event.type}`)
                .join("\n")}
            </pre>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 18 }}>
        <h2>Deliver event</h2>
        <div className="start-form panel">
          <label>
            Event type
            <input value={eventType} onChange={(event) => setEventType(event.target.value)} />
          </label>
          <label>
            JSON payload
            <textarea value={eventData} onChange={(event) => setEventData(event.target.value)} />
          </label>
          <div className="actions">
            <button type="button" onClick={() => void sendEvent()}>
              Send event
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ChildLinks({ children }: { children: Array<{ id: string; workflowName: string; status: string }> }) {
  if (children.length === 0) {
    return null;
  }
  return (
    <ul className="timeline nested">
      {children.map((child) => (
        <li key={child.id}>
          <span className={`dot ${dotClass(child.status)}`} />
          <div>
            <a href={`#/runs/${child.id}`}>{child.workflowName}</a>
            <div className="muted">{child.status}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function AgentBranch({
  agent,
  onSelectAgent,
  onSelectTool,
  onSelectModel,
}: {
  agent: AgentRunDetail;
  onSelectAgent: (id: string) => void;
  onSelectTool: (id: string) => void;
  onSelectModel: (id: string) => void;
}) {
  return (
    <ul className="timeline nested">
      <li>
        <span className={`dot ${dotClass(agent.status)}`} />
        <div>
          <button type="button" className="linkish" onClick={() => onSelectAgent(agent.id)}>
            {agent.agentName}
          </button>
          <div className="muted">
            {agent.status} · {agent.currentTurn} turns · {agent.modelCallCount} model · {agent.toolCallCount} tools
            {agent.startedAt ? ` · ${durationMs(agent.startedAt, agent.completedAt)}` : ""}
          </div>
          <ul className="timeline nested">
            {agent.modelCalls.map((call) => (
              <li key={call.id}>
                <span className={`dot ${dotClass(call.completedAt ? "COMPLETED" : "RUNNING")}`} />
                <div>
                  <button type="button" className="linkish" onClick={() => onSelectModel(call.id)}>
                    Model call {call.model ?? call.provider}
                  </button>
                  <div className="muted">
                    {call.latencyMs != null ? `${call.latencyMs}ms` : durationMs(call.startedAt, call.completedAt)}
                    {call.tokenInput != null ? ` · in ${call.tokenInput}` : ""}
                    {call.tokenOutput != null ? ` · out ${call.tokenOutput}` : ""}
                    {call.stopReason ? ` · ${call.stopReason}` : ""}
                    {call.error ? ` · ${call.error.message}` : ""}
                  </div>
                </div>
              </li>
            ))}
            {agent.toolCalls.map((call) => (
              <li key={call.id}>
                <span className={`dot ${dotClass(call.status)}`} />
                <div>
                  <button type="button" className="linkish" onClick={() => onSelectTool(call.id)}>
                    {call.source === "mcp" ? `MCP: ${call.server ? `${call.server}.` : ""}${call.name}` : `Tool: ${call.name}`}
                  </button>
                  <div className="muted">
                    {call.status} · {durationMs(call.startedAt, call.completedAt)}
                    {call.attempt > 1 ? ` · attempt ${call.attempt}` : ""}
                    {call.error ? ` · ${call.error.message}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </li>
    </ul>
  );
}

function AgentPanel({ agent }: { agent: AgentRunDetail }) {
  return (
    <div>
      <h2>Agent run</h2>
      <div className="panel">
        <pre>
          {JSON.stringify(
            {
              id: agent.id,
              agent: agent.agentName,
              status: agent.status,
              turns: agent.currentTurn,
              modelCalls: agent.modelCallCount,
              toolCalls: agent.toolCallCount,
              limits: agent.limits,
              output: agent.output,
              error: agent.error,
              startedAt: agent.startedAt,
              completedAt: agent.completedAt,
            },
            null,
            2,
          )}
        </pre>
      </div>
    </div>
  );
}

function ModelPanel({ call }: { call: ModelCall }) {
  return (
    <div>
      <h2>Model call</h2>
      <div className="panel">
        <pre>
          {JSON.stringify(
            {
              provider: call.provider,
              model: call.model,
              latencyMs: call.latencyMs,
              tokenInput: call.tokenInput,
              tokenOutput: call.tokenOutput,
              stopReason: call.stopReason,
              attempt: call.attempt,
              error: call.error,
              request: call.request,
              response: call.response,
            },
            null,
            2,
          )}
        </pre>
      </div>
    </div>
  );
}

function ToolPanel({ call }: { call: ToolCall }) {
  return (
    <div>
      <h2>Tool call</h2>
      <div className="panel">
        <pre>
          {JSON.stringify(
            {
              name: call.name,
              source: call.source,
              server: call.server,
              status: call.status,
              attempt: call.attempt,
              arguments: call.arguments,
              result: call.result,
              error: call.error,
              startedAt: call.startedAt,
              completedAt: call.completedAt,
            },
            null,
            2,
          )}
        </pre>
      </div>
    </div>
  );
}
