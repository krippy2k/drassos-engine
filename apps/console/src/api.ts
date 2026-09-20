export interface RunSummary {
  id: string;
  workflowName: string;
  workflowVersion?: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs?: number | null;
  currentStep?: string | null;
  estimatedCostUsd?: number | null;
  parentRunId?: string | null;
  forkedFromRunId?: string | null;
  forkedFromSeq?: number | null;
  error?: { message: string } | null;
}

export interface RunListResponse {
  runs: RunSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface HistoryEvent {
  id: string;
  seq: number;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface StepRun {
  id: string;
  name: string;
  type: string;
  status: string;
  attempt: number;
  startedAt: string | null;
  completedAt: string | null;
  error: { message: string } | null;
}

export interface HumanTask {
  id: string;
  runId: string;
  name: string;
  title: string;
  assignedTo: string | null;
  status: string;
  data: unknown;
  response: unknown;
  createdAt: string;
}

export interface AgentTurn {
  id: string;
  turnNumber: number;
  startedAt: string;
  completedAt: string | null;
  requestedTools: unknown;
  error: { message: string } | null;
}

export interface ModelCall {
  id: string;
  agentRunId: string;
  agentTurnId: string;
  provider: string;
  model: string | null;
  request: unknown;
  response: unknown;
  tokenInput: number | null;
  tokenOutput: number | null;
  latencyMs: number | null;
  stopReason: string | null;
  attempt: number;
  error: { message: string } | null;
  startedAt: string;
  completedAt: string | null;
}

export interface ToolCall {
  id: string;
  agentRunId: string;
  name: string;
  source: string;
  server: string | null;
  arguments: unknown;
  result: unknown;
  status: string;
  attempt: number;
  error: { message: string } | null;
  startedAt: string;
  completedAt: string | null;
}

export interface AgentRunDetail {
  id: string;
  stepRunId?: string;
  agentName: string;
  status: string;
  currentTurn: number;
  toolCallCount: number;
  modelCallCount: number;
  limits: Record<string, unknown>;
  output: unknown;
  error: { message: string } | null;
  startedAt: string;
  completedAt: string | null;
  turns: AgentTurn[];
  modelCalls: ModelCall[];
  toolCalls: ToolCall[];
}

export interface ExecutionNode {
  executionId: string;
  type: string;
  name: string;
  status: string;
  children: ExecutionNode[];
}

export interface ObservableOperation {
  id: string;
  type: string;
  name: string;
  parentId: string | null;
  status: string;
  durationMs: number | null;
  attempt: number;
  input: unknown;
  output: unknown;
  error: unknown;
  attributes: Record<string, unknown>;
  children: ObservableOperation[];
}

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  status: string;
  runId: string;
  parentId: string | null;
  durationMs: number | null;
  attempt: number;
  x: number;
  y: number;
}

export interface ExecutionGraph {
  nodes: GraphNode[];
  edges: Array<{ from: string; to: string }>;
}

export interface HistoricalSnapshot {
  seq: number;
  timestamp: string | null;
  runStatus: string;
  waitType: string | null;
  completedSteps: Array<{ id: string; name: string; type: string; output: unknown }>;
  pendingSteps: Array<{ id: string; name: string; type: string; status: string }>;
  pendingTimers: Array<{ id: string; fireAt: string; status: string }>;
  pendingHuman: Array<{ id: string; title: string; status: string }>;
  pendingSignals: string[];
  children: Array<{ id: string; workflowName: string; status: string }>;
  agentOutputs: Array<{ id: string; name: string; output: unknown; status: string }>;
}

export interface ObservabilityMetrics {
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
  waitingHuman: number;
  successRate: number;
  retryRate: number;
  toolFailureRate: number;
  workflowLatency: { p50: number | null; p95: number | null; p99: number | null };
  agentLatency: { p50: number | null; p95: number | null; p99: number | null };
  toolLatency: { p50: number | null; p95: number | null; p99: number | null };
  tokenInput: number;
  tokenOutput: number;
  estimatedCostUsd: number;
  replayAttempts?: number;
  replaySuccesses?: number;
  replayDivergences?: number;
  replayDuration?: { p50: number | null; p95: number | null; p99: number | null };
  waitingCompatibleWorkers?: number;
  executionsByVersion?: Array<{ workflowName: string; version: string; count: number }>;
  workersByVersion?: Array<{ version: string; workers: number }>;
}

export interface RunDetail {
  run: RunSummary & { input: unknown; output: unknown; error: unknown; workflowVersion?: string };
  steps: StepRun[];
  history: HistoryEvent[];
  tasks: HumanTask[];
  timers: Array<{ id: string; fireAt: string; status: string }>;
  events: Array<{ id: string; type: string; consumedAt: string | null }>;
  tools: Array<{ id: string; name: string; startedAt: string; completedAt: string | null }>;
  agents: Array<{ id: string; provider: string; model: string | null }>;
  agentRuns?: AgentRunDetail[];
  toolCalls?: ToolCall[];
  modelCalls?: ModelCall[];
  children?: RunSummary[];
  parent?: RunSummary | null;
  estimatedCostUsd?: number | null;
  tree?: ExecutionNode;
  waitingFor?: { type: string; name?: string | null; title?: string; createdAt?: string } | null;
  interactions?: HumanInteraction[];
  replays?: Array<{
    id: string;
    recordedVersion: string;
    testedVersion: string;
    status: string;
    eventsReplayed: number;
    durationMs: number | null;
    divergences: unknown;
    createdAt: string | null;
  }>;
}

export interface HumanInteraction {
  id: string;
  runId: string;
  interactionId: string;
  type: string;
  title: string;
  description: string | null;
  status: string;
  decision: unknown;
  createdAt: string;
  completedAt: string | null;
}

export interface RunQuery {
  workflow?: string;
  status?: string;
  agent?: string;
  worker?: string;
  failed?: boolean;
  minDurationMs?: number;
  maxDurationMs?: number;
  limit?: number;
  offset?: number;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      throw new Error(parsed.error?.message || body || response.statusText);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(body || response.statusText);
      }
      throw error;
    }
  }
  return response.json() as Promise<T>;
}

function queryString(query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") {
      continue;
    }
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export interface ReplayResult {
  ok: boolean;
  executionId: string;
  workflowName: string;
  recordedVersion: string;
  testedVersion: string;
  eventsReplayed: number;
  divergences: Array<{
    kind: string;
    expected: string;
    actual: string;
    historySequence: number | null;
    reason: string;
  }>;
  durationMs: number;
  output: unknown;
  suspended: boolean;
}

export const api = {
  workflows: () =>
    http<{ workflows: Array<{ name: string; version: string; versions?: string[]; defaultVersion?: string }> }>("/workflows"),
  runs: (query: RunQuery = {}) =>
    http<RunListResponse>(
      `/runs${queryString({
        workflow: query.workflow,
        status: query.status,
        agent: query.agent,
        worker: query.worker,
        failed: query.failed ? true : undefined,
        minDurationMs: query.minDurationMs,
        maxDurationMs: query.maxDurationMs,
        limit: query.limit ?? 50,
        offset: query.offset ?? 0,
      })}`,
    ),
  run: (id: string) => http<RunDetail>(`/runs/${id}`),
  events: (id: string) => http<{ events: HistoryEvent[]; history: HistoryEvent[] }>(`/runs/${id}/events`),
  trace: (id: string) => http<{ trace: ObservableOperation }>(`/runs/${id}/trace`),
  graph: (id: string) => http<ExecutionGraph>(`/runs/${id}/graph`),
  logs: (id: string) => http<{ logs: Array<{ timestamp: string; type: string; message: string; seq: number; payload: unknown }> }>(`/runs/${id}/logs`),
  snapshot: (id: string, seq: number) => http<HistoricalSnapshot>(`/runs/${id}/snapshot?seq=${seq}`),
  fork: (id: string, seq: number) =>
    http<RunSummary>(`/runs/${id}/fork`, {
      method: "POST",
      body: JSON.stringify({ seq }),
    }),
  metrics: () => http<ObservabilityMetrics>("/metrics/overview"),
  startRun: (workflow: string, input: unknown, version?: string) =>
    http<RunSummary>(`/workflows/${encodeURIComponent(workflow)}/runs`, {
      method: "POST",
      body: JSON.stringify({ input, version }),
    }),
  replay: (id: string, version?: string) =>
    http<ReplayResult>(`/runs/${id}/replay`, {
      method: "POST",
      body: JSON.stringify({ version }),
    }),
  exportRun: (id: string) => http<unknown>(`/runs/${id}/export`),
  deliverEvent: (runId: string, type: string, data: unknown) =>
    http<{ eventId: string; duplicate: boolean }>(`/runs/${encodeURIComponent(runId)}/events`, {
      method: "POST",
      body: JSON.stringify({ type, data }),
    }),
  signal: (runId: string, name: string, payload: unknown, id?: string) =>
    http<{ signalId: string; duplicate: boolean }>(
      `/workflows/${encodeURIComponent(runId)}/signals/${encodeURIComponent(name)}`,
      {
        method: "POST",
        body: JSON.stringify({ payload, id }),
      },
    ),
  tasks: () => http<{ tasks: HumanTask[] }>("/human-tasks"),
  interactions: (runId?: string) =>
    http<{ interactions: HumanInteraction[] }>(
      runId
        ? `/workflows/${encodeURIComponent(runId)}/interactions`
        : "/interactions",
    ),
  completeInteraction: (runId: string, interactionId: string, decision: unknown) =>
    http<HumanInteraction>(
      `/workflows/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(interactionId)}/complete`,
      {
        method: "POST",
        body: JSON.stringify(decision),
      },
    ),
  completeTask: (id: string, response: unknown) =>
    http<HumanTask>(`/human-tasks/${id}/complete`, {
      method: "POST",
      body: JSON.stringify({ response }),
    }),
};
