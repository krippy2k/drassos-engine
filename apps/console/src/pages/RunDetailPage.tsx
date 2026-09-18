import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type ExecutionGraph,
  type HistoricalSnapshot,
  type HistoryEvent,
  type ObservableOperation,
  type ReplayResult,
  type RunDetail,
} from "../api.ts";
import {
  filterEvents,
  flattenTree,
  formatDuration,
  graphBounds,
  nodeKindColor,
  reconnectDelay,
  safeJson,
  statusFill,
  visibleGraph,
  type FlattenedOperation,
} from "../debug.ts";

function isTerminal(status: string | undefined): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
}

export function RunDetailPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [trace, setTrace] = useState<ObservableOperation | null>(null);
  const [graph, setGraph] = useState<ExecutionGraph | null>(null);
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [snapshot, setSnapshot] = useState<HistoricalSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [eventFilter, setEventFilter] = useState("");
  const [seq, setSeq] = useState(0);
  const [live, setLive] = useState("connecting");
  const [error, setError] = useState<string | null>(null);
  const [eventType, setEventType] = useState("refund.confirmed");
  const [eventData, setEventData] = useState('{\n  "ok": true\n}');
  const [pan, setPan] = useState({ x: 0, y: 0, scale: 1 });
  const [replayVersion, setReplayVersion] = useState("");
  const [replay, setReplay] = useState<ReplayResult | null>(null);
  const [replaying, setReplaying] = useState(false);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null);

  async function refresh() {
    const [run, nextTrace, nextGraph, nextEvents] = await Promise.all([
      api.run(id),
      api.trace(id),
      api.graph(id),
      api.events(id),
    ]);
    setDetail(run);
    setTrace(nextTrace.trace);
    setGraph(nextGraph);
    setEvents(nextEvents.events ?? nextEvents.history ?? []);
    const last = (nextEvents.events ?? nextEvents.history ?? []).at(-1);
    setSeq((current) => current || last?.seq || 0);
  }

  useEffect(() => {
    void refresh().catch((err: Error) => setError(err.message));
  }, [id]);

  useEffect(() => {
    if (!seq) {
      return;
    }
    void api.snapshot(id, seq).then(setSnapshot).catch(() => undefined);
  }, [id, seq]);

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let attempt = 0;
    let timer: number | undefined;

    const connect = () => {
      if (closed) {
        return;
      }
      source = new EventSource(`/runs/${id}/stream`);
      setLive("live");
      const onUpdate = () => {
        attempt = 0;
        void refresh();
      };
      source.addEventListener("history", onUpdate);
      source.addEventListener("run.status", (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as { status?: string };
        if (isTerminal(payload.status)) {
          setLive("complete");
          source?.close();
        }
        onUpdate();
      });
      source.onerror = () => {
        source?.close();
        if (closed) {
          return;
        }
        setLive("reconnect");
        attempt += 1;
        timer = window.setTimeout(connect, reconnectDelay(attempt));
      };
    };
    connect();
    return () => {
      closed = true;
      source?.close();
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [id]);

  const operations = useMemo(() => flattenTree(trace as FlattenedOperation | null), [trace]);
  const selected = operations.find((item) => item.id === selectedId) ?? operations[0] ?? null;
  const shown = graph ? visibleGraph(graph, collapsed) : null;
  const bounds = graphBounds(shown?.nodes ?? []);
  const filteredHistory = filterEvents(events, eventFilter);

  async function sendEvent() {
    setError(null);
    try {
      await api.deliverEvent(id, eventType, JSON.parse(eventData) as unknown);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function forkAt() {
    setError(null);
    try {
      const run = await api.fork(id, seq);
      window.location.hash = `/runs/${run.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runReplay() {
    setError(null);
    setReplaying(true);
    try {
      const result = await api.replay(id, replayVersion || undefined);
      setReplay(result);
      const jump = result.divergences[0]?.historySequence;
      if (jump) {
        setSeq(jump);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReplaying(false);
    }
  }

  if (error && !detail) {
    return <p className="muted">{error}</p>;
  }
  if (!detail) {
    return <p className="muted">Loading run…</p>;
  }

  const { run, parent, children = [], waitingFor } = detail;

  return (
    <section className="debug-page">
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
          <p className="muted">
            {run.id} · {run.workflowName}@{run.workflowVersion ?? "1"} · live {live}
            {run.forkedFromRunId ? ` · forked from ${run.forkedFromRunId.slice(0, 8)}@${run.forkedFromSeq}` : ""}
          </p>
        </div>
        <span className={`badge ${run.status}`}>{run.status}</span>
      </div>
      {error && <p className="error">{error}</p>}
      {waitingFor && (
        <p className="waiting-banner">
          Waiting for {waitingFor.type}
          {waitingFor.title ? `: ${waitingFor.title}` : waitingFor.name ? `: ${waitingFor.name}` : ""}
        </p>
      )}

      <div className="graph-toolbar">
        <button className="secondary" type="button" onClick={() => setPan({ x: 0, y: 0, scale: 1 })}>
          Fit
        </button>
        <button className="secondary" type="button" onClick={() => setPan((value) => ({ ...value, scale: value.scale * 1.15 }))}>
          Zoom in
        </button>
        <button className="secondary" type="button" onClick={() => setPan((value) => ({ ...value, scale: value.scale / 1.15 }))}>
          Zoom out
        </button>
        <span className="muted">Drag to pan. Click a node to inspect. Double-click to collapse children.</span>
      </div>

      <div
        className="graph-canvas panel"
        onWheel={(event) => {
          event.preventDefault();
          setPan((value) => ({ ...value, scale: Math.min(3, Math.max(0.4, value.scale * (event.deltaY < 0 ? 1.08 : 0.92))) }));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) {
            return;
          }
          const dx = event.clientX - drag.current.x;
          const dy = event.clientY - drag.current.y;
          if (!drag.current.moved && dx * dx + dy * dy < 25) {
            return;
          }
          drag.current.moved = true;
          setPan((value) => ({
            ...value,
            x: drag.current!.panX + dx,
            y: drag.current!.panY + dy,
          }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {shown && shown.nodes.length > 0 ? (
          <div
            className="graph-world"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${pan.scale})` }}
          >
            <svg
              viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`}
              focusable="false"
            >
              {shown.edges.map((edge) => {
                const from = shown.nodes.find((node) => node.id === edge.from);
                const to = shown.nodes.find((node) => node.id === edge.to);
                if (!from || !to) {
                  return null;
                }
                return (
                  <line
                    key={`${edge.from}-${edge.to}`}
                    x1={from.x + 80}
                    y1={from.y + 22}
                    x2={to.x + 80}
                    y2={to.y + 22}
                    stroke="#2c3342"
                  />
                );
              })}
              {shown.nodes.map((node) => (
                <g
                  key={node.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    setSelectedId(node.id);
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(node.id)) {
                        next.delete(node.id);
                      } else {
                        next.add(node.id);
                      }
                      return next;
                    });
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <rect
                    width="160"
                    height="44"
                    rx="10"
                    fill={statusFill(node.status ?? "")}
                    stroke={selectedId === node.id ? "#efe7d6" : nodeKindColor(node.type)}
                    strokeWidth={selectedId === node.id ? 2 : 1}
                  />
                  <text x="12" y="18" fill={nodeKindColor(node.type)} fontSize="10">
                    {node.type}
                    {collapsed.has(node.id) ? " +" : ""}
                  </text>
                  <text x="12" y="34" fill="#efe7d6" fontSize="12">
                    {String(node.name ?? node.id).slice(0, 18)}
                  </text>
                </g>
              ))}
            </svg>
          </div>
        ) : (
          <div className="empty">No graph yet.</div>
        )}
      </div>

      <div className="debug-grid">
        <div>
          <h2>Timeline</h2>
          <input
            className="filter-input"
            value={eventFilter}
            placeholder="Filter events by type"
            onChange={(event) => setEventFilter(event.target.value)}
          />
          <div className="panel timeline-panel">
            <ul className="timeline">
              {filteredHistory.map((event) => (
                <li
                  key={`${event.id}-${event.seq}`}
                  className={seq === event.seq ? "selected" : ""}
                  onClick={() => {
                    setSeq(event.seq);
                    const payload = event.payload as { stepId?: string; id?: string };
                    setSelectedId(payload.stepId ?? payload.id ?? selectedId);
                  }}
                >
                  <span className={`dot ${event.type.includes("fail") ? "fail" : event.type.includes("complete") ? "done" : "wait"}`} />
                  <div>
                    <strong>{event.type}</strong>
                    <div className="muted">
                      {new Date(event.timestamp).toISOString().slice(11, 23)} · seq {event.seq}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div>
          <h2>Inspector</h2>
          <div className="panel">
            {selected ? <Inspector op={selected} /> : <div className="empty">Select a node.</div>}
          </div>
        </div>
      </div>

      <div className="debug-grid" style={{ marginTop: 18 }}>
        <div>
          <h2>Historical snapshot</h2>
          <input
            type="range"
            min={events[0]?.seq ?? 0}
            max={events.at(-1)?.seq ?? 0}
            value={seq}
            onChange={(event) => setSeq(Number(event.target.value))}
          />
          <div className="panel">
            <pre>{JSON.stringify(snapshot, null, 2)}</pre>
          </div>
          <div className="actions">
            <button className="secondary" type="button" onClick={() => void forkAt()}>
              Fork from seq {seq}
            </button>
          </div>
        </div>
        <div>
          <h2>Run summary</h2>
          <dl className="panel meta" style={{ padding: 16 }}>
            <dt>Run ID</dt>
            <dd className="mono">{run.id}</dd>
            <dt>Version</dt>
            <dd>{run.workflowVersion ?? "1"}</dd>
            <dt>Duration</dt>
            <dd>{formatDuration(run.durationMs) || "—"}</dd>
            <dt>Current step</dt>
            <dd>{run.currentStep ?? "—"}</dd>
            <dt>Error</dt>
            <dd>{run.error ? run.error.message : "—"}</dd>
            <dt>Children</dt>
            <dd>
              {children.length === 0
                ? "—"
                : children.map((child) => (
                    <div key={child.id}>
                      <a href={`#/runs/${child.id}`}>{child.workflowName}</a> · {child.status}
                    </div>
                  ))}
            </dd>
          </dl>
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <h2>Replay</h2>
        <div className="start-form panel">
          <label>
            Candidate version
            <input
              value={replayVersion}
              placeholder={run.workflowVersion ?? "recorded version"}
              onChange={(event) => setReplayVersion(event.target.value)}
            />
          </label>
          <div className="actions">
            <button type="button" disabled={replaying} onClick={() => void runReplay()}>
              {replaying ? "Replaying…" : "Replay history"}
            </button>
          </div>
          {replay && (
            <div className={replay.ok ? "replay-ok" : "replay-divergent"}>
              <p>
                {replay.ok ? "Replay successful" : "Replay divergent"} · tested {replay.testedVersion} ·{" "}
                {replay.eventsReplayed} events · {replay.durationMs}ms
              </p>
              {replay.divergences.map((item, index) => (
                <button
                  key={`${item.kind}-${index}`}
                  className="secondary"
                  type="button"
                  onClick={() => {
                    if (item.historySequence) {
                      setSeq(item.historySequence);
                    }
                  }}
                >
                  {item.kind}: expected {item.expected} · actual {item.actual}
                  {item.historySequence ? ` · seq ${item.historySequence}` : ""}
                </button>
              ))}
            </div>
          )}
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
            <button
              className="secondary"
              type="button"
              onClick={() => {
                void api.signal(id, eventType, JSON.parse(eventData) as unknown).catch((err: Error) => setError(err.message));
              }}
            >
              Send signal
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Inspector({ op }: { op: Record<string, unknown> }) {
  const attributes =
    op.attributes && typeof op.attributes === "object" && !Array.isArray(op.attributes)
      ? (op.attributes as Record<string, unknown>)
      : {};
  const children = Array.isArray(op.children)
    ? op.children.filter((child): child is Record<string, unknown> => Boolean(child) && typeof child === "object")
    : [];
  return (
    <div className="inspector">
      <p>
        <strong>{String(op.name)}</strong>
        <span className={`badge ${String(op.status)}`} style={{ marginLeft: 8 }}>
          {String(op.status)}
        </span>
      </p>
      <p className="muted">
        {String(op.type)} · {formatDuration(typeof op.durationMs === "number" ? op.durationMs : null)}
        {typeof op.attempt === "number" && op.attempt > 1 ? ` · attempt ${op.attempt}` : ""}
      </p>
      {typeof attributes.estimatedCostUsd === "number" && (
        <p>Estimated cost ${attributes.estimatedCostUsd.toFixed(4)}</p>
      )}
      {(attributes.tokenInput != null || attributes.tokenOutput != null) && (
        <p className="muted">
          Tokens in {String(attributes.tokenInput ?? 0)} / out {String(attributes.tokenOutput ?? 0)}
        </p>
      )}
      {op.type === "child" && typeof attributes.childRunId === "string" && (
        <p>
          <a href={`#/runs/${String(attributes.childRunId)}`}>Open child run</a>
        </p>
      )}
      {children.length > 0 && (
        <p className="muted">
          {children.filter((child) => child.type === "model").length} model · {children.filter((child) => child.type === "tool" || child.type === "mcp").length} tools
        </p>
      )}
      <pre>
        {safeJson({
          id: op.id,
          input: op.input,
          output: op.output,
          error: op.error,
          attributes: op.attributes,
        })}
      </pre>
    </div>
  );
}
