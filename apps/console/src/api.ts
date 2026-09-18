export interface RunSummary {
  id: string;
  workflowName: string;
  workflowVersion?: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  parentRunId?: string | null;
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

export const api = {
  workflows: () => http<{ workflows: Array<{ name: string; version: string }> }>("/workflows"),
  runs: () => http<{ runs: RunSummary[] }>("/runs"),
  run: (id: string) => http<RunDetail>(`/runs/${id}`),
  startRun: (workflow: string, input: unknown) =>
    http<RunSummary>(`/workflows/${encodeURIComponent(workflow)}/runs`, {
      method: "POST",
      body: JSON.stringify({ input }),
    }),
  deliverEvent: (runId: string, type: string, data: unknown) =>
    http<{ eventId: string; duplicate: boolean }>(`/runs/${encodeURIComponent(runId)}/events`, {
      method: "POST",
      body: JSON.stringify({ type, data }),
    }),
  tasks: () => http<{ tasks: HumanTask[] }>("/human-tasks"),
  completeTask: (id: string, response: unknown) =>
    http<HumanTask>(`/human-tasks/${id}/complete`, {
      method: "POST",
      body: JSON.stringify({ response }),
    }),
};
