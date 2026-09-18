import { randomUUID } from "node:crypto";
import { parseJson, requiredIso, toIso, toJson } from "../core/serialize.ts";
import type {
  AgentExecution,
  AgentLimits,
  AgentRunRecord,
  AgentRunStatus,
  AgentTurnRecord,
  DurableTimer,
  ExternalEvent,
  HistoryEvent,
  HistoryEventType,
  HumanTask,
  HumanTaskStatus,
  HumanInteraction,
  HumanInteractionStatus,
  HumanDecision,
  Json,
  ModelCallRecord,
  PersistedError,
  StepRun,
  StepStatus,
  StepType,
  TaskStatus,
  ToolCallRecord,
  ToolInvocation,
  ToolSource,
  WorkItem,
  WorkItemType,
  WorkflowRun,
  WorkflowStatus,
} from "../core/types.ts";
import { DEFAULT_TASK_QUEUE } from "../core/types.ts";
import { StaleLeaseError } from "../core/errors.ts";
import type { RemoteOperation, RemoteOperationStatus } from "../capabilities/types.ts";
import type { DbClient } from "./client.ts";

function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function mapRun(row: Record<string, unknown>): WorkflowRun {
  return {
    id: String(row.id),
    workflowName: String(row.workflow_name),
    workflowVersion: String(row.workflow_version),
    input: parseJson(row.input),
    output: row.output === null || row.output === undefined ? null : parseJson(row.output),
    status: String(row.status) as WorkflowStatus,
    error: row.error ? (parseJson(row.error) as unknown as PersistedError) : null,
    cancellation: row.cancellation
      ? (parseJson(row.cancellation) as unknown as WorkflowRun["cancellation"])
      : null,
    waitType: (row.wait_type as WorkflowRun["waitType"]) ?? null,
    waitRef: row.wait_ref ? String(row.wait_ref) : null,
    parentRunId: row.parent_run_id ? String(row.parent_run_id) : null,
    parentStepId: row.parent_step_id ? String(row.parent_step_id) : null,
    childDepth: row.child_depth === null || row.child_depth === undefined ? 0 : Number(row.child_depth),
    cancelOnParentCancel: row.cancel_on_parent_cancel === false || row.cancel_on_parent_cancel === "f" ? false : true,
    rootRunId: row.root_run_id ? String(row.root_run_id) : String(row.id),
    failurePolicy: row.failure_policy === "return-error" ? "return-error" : "fail-parent",
    cancellationPolicy: row.cancellation_policy === "detach" ? "detach" : "propagate",
    timeoutAt: toIso(row.timeout_at as Date | string | null),
    forkedFromRunId: row.forked_from_run_id ? String(row.forked_from_run_id) : null,
    forkedFromSeq: row.forked_from_seq === null || row.forked_from_seq === undefined ? null : Number(row.forked_from_seq),
    historyFormatVersion: row.history_format_version === null || row.history_format_version === undefined ? 1 : Number(row.history_format_version),
    createdAt: requiredIso(row.created_at as Date | string),
    startedAt: toIso(row.started_at as Date | string | null),
    completedAt: toIso(row.completed_at as Date | string | null),
  };
}

function mapStep(row: Record<string, unknown>): StepRun {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    name: String(row.name),
    occurrence: Number(row.occurrence),
    type: String(row.type) as StepType,
    input: row.input === null || row.input === undefined ? null : parseJson(row.input),
    output: row.output === null || row.output === undefined ? null : parseJson(row.output),
    status: String(row.status) as StepStatus,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    error: row.error ? (parseJson(row.error) as unknown as PersistedError) : null,
    timeoutMs: row.timeout_ms === null || row.timeout_ms === undefined ? null : Number(row.timeout_ms),
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    startedAt: toIso(row.started_at as Date | string | null),
    completedAt: toIso(row.completed_at as Date | string | null),
  };
}

function mapHistory(row: Record<string, unknown>): HistoryEvent {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    seq: Number(row.seq),
    type: String(row.type) as HistoryEventType,
    timestamp: requiredIso(row.timestamp as Date | string),
    payload: parseJson(row.payload),
  };
}

function mapWork(row: Record<string, unknown>): WorkItem {
  const status = row.status ? (String(row.status) as TaskStatus) : row.completed_at ? "completed" : row.lease_owner ? "leased" : "pending";
  return {
    id: String(row.id),
    runId: String(row.run_id),
    type: String(row.type) as WorkItemType,
    name: row.name ? String(row.name) : null,
    queue: row.queue ? String(row.queue) : DEFAULT_TASK_QUEUE,
    payload: parseJson(row.payload),
    status,
    attempt: row.attempt === null || row.attempt === undefined ? 0 : Number(row.attempt),
    maxAttempts: row.max_attempts === null || row.max_attempts === undefined ? 1 : Number(row.max_attempts),
    priority: row.priority === null || row.priority === undefined ? 0 : Number(row.priority),
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseToken: row.lease_token ? String(row.lease_token) : null,
    leaseExpiresAt: toIso(row.lease_expires_at as Date | string | null),
    result: row.result === null || row.result === undefined ? null : parseJson(row.result),
    error: row.error ? (parseJson(row.error) as unknown as PersistedError) : null,
    progress: row.progress === null || row.progress === undefined ? null : parseJson(row.progress),
    availableAt: requiredIso(row.available_at as Date | string),
    startedAt: toIso(row.started_at as Date | string | null),
    completedAt: toIso(row.completed_at as Date | string | null),
    createdAt: requiredIso(row.created_at as Date | string),
  };
}

function mapHuman(row: Record<string, unknown>): HumanTask {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stepRunId: String(row.step_run_id),
    name: String(row.name),
    occurrence: Number(row.occurrence),
    title: String(row.title),
    assignedTo: row.assigned_to ? String(row.assigned_to) : null,
    data: parseJson(row.data),
    response: row.response === null || row.response === undefined ? null : parseJson(row.response),
    status: String(row.status) as HumanTaskStatus,
    createdAt: requiredIso(row.created_at as Date | string),
    completedAt: toIso(row.completed_at as Date | string | null),
  };
}

function mapTimer(row: Record<string, unknown>): DurableTimer {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stepRunId: String(row.step_run_id),
    fireAt: requiredIso(row.fire_at as Date | string),
    firedAt: toIso(row.fired_at as Date | string | null),
    status: String(row.status) as DurableTimer["status"],
  };
}

function mapEvent(row: Record<string, unknown>): ExternalEvent {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    type: String(row.type),
    data: parseJson(row.data),
    receivedAt: requiredIso(row.received_at as Date | string),
    consumedAt: toIso(row.consumed_at as Date | string | null),
    consumedByStepId: row.consumed_by_step_id ? String(row.consumed_by_step_id) : null,
    deliveryId: row.delivery_id ? String(row.delivery_id) : null,
  };
}

function mapTool(row: Record<string, unknown>): ToolInvocation {
  return {
    id: String(row.id),
    stepRunId: String(row.step_run_id),
    runId: String(row.run_id),
    name: String(row.name),
    input: parseJson(row.input),
    output: row.output === null || row.output === undefined ? null : parseJson(row.output),
    error: row.error ? (parseJson(row.error) as unknown as PersistedError) : null,
    startedAt: requiredIso(row.started_at as Date | string),
    completedAt: toIso(row.completed_at as Date | string | null),
  };
}

function mapAgent(row: Record<string, unknown>): AgentExecution {
  return {
    id: String(row.id),
    stepRunId: String(row.step_run_id),
    runId: String(row.run_id),
    provider: String(row.provider),
    model: row.model ? String(row.model) : null,
    messages: row.messages === null || row.messages === undefined ? null : parseJson(row.messages),
    tokenInput: row.token_input === null || row.token_input === undefined ? null : Number(row.token_input),
    tokenOutput: row.token_output === null || row.token_output === undefined ? null : Number(row.token_output),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
  };
}

export class Store {
  constructor(private readonly db: DbClient) {}

  async transaction<T>(fn: (store: Store) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(new Store(tx)));
  }

  async registerWorkflow(name: string, version: string, sourceHash?: string): Promise<void> {
    await this.db.query(
      `INSERT INTO workflow_definitions (name, version, registered_at)
       VALUES ($1, $2, now())
       ON CONFLICT (name) DO UPDATE SET version = EXCLUDED.version, registered_at = now()`,
      [name, version],
    );
    await this.db.query(
      `INSERT INTO workflow_versions (name, version, source_hash, registered_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (name, version) DO NOTHING`,
      [name, version, sourceHash ?? null],
    );
  }

  async listWorkflowDefinitions(): Promise<Array<{ name: string; version: string; registeredAt: string }>> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT name, version, registered_at FROM workflow_definitions ORDER BY name",
    );
    return result.rows.map((row) => ({
      name: String(row.name),
      version: String(row.version),
      registeredAt: requiredIso(row.registered_at as Date | string),
    }));
  }

  async createRun(input: {
    id?: string;
    workflowName: string;
    workflowVersion: string;
    input: unknown;
    parentRunId?: string | null;
    parentStepId?: string | null;
    childDepth?: number;
    cancelOnParentCancel?: boolean;
    rootRunId?: string | null;
    failurePolicy?: "fail-parent" | "return-error";
    cancellationPolicy?: "propagate" | "detach";
    timeoutAt?: string | null;
    forkedFromRunId?: string | null;
    forkedFromSeq?: number | null;
  }): Promise<WorkflowRun> {
    const id = input.id ?? randomUUID();
    const rootRunId = input.rootRunId ?? (input.parentRunId ? input.parentRunId : id);
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO workflow_runs (
         id, workflow_name, workflow_version, input, status,
         parent_run_id, parent_step_id, child_depth, cancel_on_parent_cancel,
         root_run_id, failure_policy, cancellation_policy, timeout_at,
         forked_from_run_id, forked_from_seq
       )
       VALUES ($1, $2, $3, $4::jsonb, 'PENDING', $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13, $14)
       RETURNING *`,
      [
        id,
        input.workflowName,
        input.workflowVersion,
        jsonParam(toJson(input.input)),
        input.parentRunId ?? null,
        input.parentStepId ?? null,
        input.childDepth ?? 0,
        input.cancelOnParentCancel ?? true,
        rootRunId,
        input.failurePolicy ?? "fail-parent",
        input.cancellationPolicy ?? "propagate",
        input.timeoutAt ?? null,
        input.forkedFromRunId ?? null,
        input.forkedFromSeq ?? null,
      ],
    );
    return mapRun(result.rows[0]!);
  }

  async getRun(id: string): Promise<WorkflowRun | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM workflow_runs WHERE id = $1",
      [id],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async listRuns(opts?: { limit?: number; workflow?: string }): Promise<WorkflowRun[]> {
    const result = await this.queryRuns({ workflow: opts?.workflow, limit: opts?.limit ?? 50, offset: 0 });
    return result.rows;
  }

  async queryRuns(opts: {
    workflow?: string;
    version?: string;
    status?: string;
    agent?: string;
    worker?: string;
    from?: string;
    to?: string;
    failed?: boolean;
    minDurationMs?: number;
    maxDurationMs?: number;
    limit: number;
    offset: number;
  }): Promise<{ rows: WorkflowRun[]; total: number }> {
    const clauses: string[] = ["1=1"];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      clauses.push(sql.replace("?", `$${params.length}`));
    };
    if (opts.workflow) {
      add("workflow_name = ?", opts.workflow);
    }
    if (opts.version) {
      add("workflow_version = ?", opts.version);
    }
    if (opts.status) {
      add("status = ?", opts.status);
    }
    if (opts.failed) {
      clauses.push("status = 'FAILED'");
    }
    if (opts.from) {
      add("created_at >= ?::timestamptz", opts.from);
    }
    if (opts.to) {
      add("created_at <= ?::timestamptz", opts.to);
    }
    if (opts.agent) {
      add("EXISTS (SELECT 1 FROM agent_runs ar WHERE ar.run_id = workflow_runs.id AND ar.agent_name = ?)", opts.agent);
    }
    if (opts.worker) {
      params.push(opts.worker, opts.worker);
      clauses.push(
        `(execution_owner = $${params.length - 1} OR EXISTS (SELECT 1 FROM work_items w WHERE w.run_id = workflow_runs.id AND w.lease_owner = $${params.length}))`,
      );
    }
    if (opts.minDurationMs !== undefined) {
      add(
        "EXTRACT(EPOCH FROM (COALESCE(completed_at, now()) - COALESCE(started_at, created_at))) * 1000 >= ?",
        opts.minDurationMs,
      );
    }
    if (opts.maxDurationMs !== undefined) {
      add(
        "EXTRACT(EPOCH FROM (COALESCE(completed_at, now()) - COALESCE(started_at, created_at))) * 1000 <= ?",
        opts.maxDurationMs,
      );
    }
    const where = clauses.join(" AND ");
    const count = await this.db.query<Record<string, unknown>>(`SELECT COUNT(*)::int AS n FROM workflow_runs WHERE ${where}`, params);
    params.push(opts.limit, opts.offset);
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM workflow_runs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { rows: result.rows.map(mapRun), total: Number(count.rows[0]?.n ?? 0) };
  }

  async lockRun(id: string): Promise<WorkflowRun | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE SKIP LOCKED",
      [id],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async tryAcquireRun(id: string, workerId: string, leaseMs: number): Promise<WorkflowRun | null> {
    const expires = new Date(Date.now() + leaseMs).toISOString();
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE workflow_runs
       SET execution_owner = $2, execution_expires_at = $3::timestamptz
       WHERE id = $1
         AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
         AND (execution_expires_at IS NULL OR execution_expires_at < now())
       RETURNING *`,
      [id, workerId, expires],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async heartbeatRun(id: string, workerId: string, leaseMs: number): Promise<boolean> {
    const expires = new Date(Date.now() + leaseMs).toISOString();
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE workflow_runs
       SET execution_expires_at = $3::timestamptz
       WHERE id = $1 AND execution_owner = $2 AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
       RETURNING id`,
      [id, workerId, expires],
    );
    return result.rows.length > 0;
  }

  async releaseRun(id: string, workerId: string): Promise<void> {
    await this.db.query(
      `UPDATE workflow_runs
       SET execution_owner = NULL, execution_expires_at = NULL
       WHERE id = $1 AND execution_owner = $2`,
      [id, workerId],
    );
  }

  async updateRun(id: string, patch: {
    status?: WorkflowStatus;
    output?: Json | null;
    error?: PersistedError | null;
    cancellation?: WorkflowRun["cancellation"];
    waitType?: WorkflowRun["waitType"];
    waitRef?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  }): Promise<WorkflowRun> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE workflow_runs SET
         status = COALESCE($2, status),
         output = CASE WHEN $3 THEN $4::jsonb ELSE output END,
         error = CASE WHEN $5 THEN $6::jsonb ELSE error END,
         cancellation = CASE WHEN $7 THEN $8::jsonb ELSE cancellation END,
         wait_type = CASE WHEN $9 THEN $10 ELSE wait_type END,
         wait_ref = CASE WHEN $11 THEN $12 ELSE wait_ref END,
         started_at = COALESCE($13::timestamptz, started_at),
         completed_at = COALESCE($14::timestamptz, completed_at)
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.status ?? null,
        patch.output !== undefined,
        patch.output !== undefined ? jsonParam(patch.output) : null,
        patch.error !== undefined,
        patch.error !== undefined ? jsonParam(patch.error) : null,
        patch.cancellation !== undefined,
        patch.cancellation !== undefined ? jsonParam(patch.cancellation) : null,
        patch.waitType !== undefined,
        patch.waitType ?? null,
        patch.waitRef !== undefined,
        patch.waitRef ?? null,
        patch.startedAt ?? null,
        patch.completedAt ?? null,
      ],
    );
    if (!result.rows[0]) {
      throw new Error(`Run not found: ${id}`);
    }
    return mapRun(result.rows[0]);
  }

  async getStepByIdentity(runId: string, name: string, occurrence: number): Promise<StepRun | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM step_runs WHERE run_id = $1 AND name = $2 AND occurrence = $3",
      [runId, name, occurrence],
    );
    return result.rows[0] ? mapStep(result.rows[0]) : null;
  }

  async getStep(id: string): Promise<StepRun | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM step_runs WHERE id = $1",
      [id],
    );
    return result.rows[0] ? mapStep(result.rows[0]) : null;
  }

  async listSteps(runId: string): Promise<StepRun[]> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM step_runs WHERE run_id = $1 ORDER BY started_at NULLS LAST, name, occurrence",
      [runId],
    );
    return result.rows.map(mapStep);
  }

  async insertStep(step: {
    id?: string;
    runId: string;
    name: string;
    occurrence: number;
    type: StepType;
    input?: unknown;
    status: StepStatus;
    attempt: number;
    maxAttempts: number;
    timeoutMs?: number | null;
    idempotencyKey?: string | null;
    startedAt?: string | null;
  }): Promise<StepRun> {
    const id = step.id ?? randomUUID();
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO step_runs (
         id, run_id, name, occurrence, type, input, status, attempt, max_attempts,
         timeout_ms, idempotency_key, started_at
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::timestamptz)
       RETURNING *`,
      [
        id,
        step.runId,
        step.name,
        step.occurrence,
        step.type,
        jsonParam(step.input ?? null),
        step.status,
        step.attempt,
        step.maxAttempts,
        step.timeoutMs ?? null,
        step.idempotencyKey ?? null,
        step.startedAt ?? null,
      ],
    );
    return mapStep(result.rows[0]!);
  }

  async updateStep(id: string, patch: {
    status?: StepStatus;
    attempt?: number;
    output?: Json | null;
    error?: PersistedError | null;
    startedAt?: string | null;
    completedAt?: string | null;
  }): Promise<StepRun> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE step_runs SET
         status = COALESCE($2, status),
         attempt = COALESCE($3, attempt),
         output = CASE WHEN $4 THEN $5::jsonb ELSE output END,
         error = CASE WHEN $6 THEN $7::jsonb ELSE error END,
         started_at = COALESCE($8::timestamptz, started_at),
         completed_at = COALESCE($9::timestamptz, completed_at)
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.status ?? null,
        patch.attempt ?? null,
        patch.output !== undefined,
        patch.output !== undefined ? jsonParam(patch.output) : null,
        patch.error !== undefined,
        patch.error !== undefined ? jsonParam(patch.error) : null,
        patch.startedAt ?? null,
        patch.completedAt ?? null,
      ],
    );
    if (!result.rows[0]) {
      throw new Error(`Step not found: ${id}`);
    }
    return mapStep(result.rows[0]);
  }

  async appendHistory(event: {
    runId: string;
    type: HistoryEventType;
    payload?: unknown;
    timestamp?: string;
  }): Promise<HistoryEvent> {
    const id = randomUUID();
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO history_events (id, run_id, seq, type, timestamp, payload)
       VALUES (
         $1,
         $2,
         COALESCE((SELECT MAX(seq) FROM history_events WHERE run_id = $2), 0) + 1,
         $3,
         COALESCE($4::timestamptz, now()),
         $5::jsonb
       )
       RETURNING *`,
      [id, event.runId, event.type, event.timestamp ?? null, jsonParam(event.payload ?? {})],
    );
    return mapHistory(result.rows[0]!);
  }

  async listHistory(runId: string, opts?: { afterSeq?: number; limit?: number }): Promise<HistoryEvent[]> {
    if (opts?.afterSeq !== undefined) {
      const result = await this.db.query<Record<string, unknown>>(
        "SELECT * FROM history_events WHERE run_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3",
        [runId, opts.afterSeq, opts.limit ?? 500],
      );
      return result.rows.map(mapHistory);
    }
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM history_events WHERE run_id = $1 ORDER BY seq ASC",
      [runId],
    );
    return result.rows.map(mapHistory);
  }

  async countHistoryType(type: string): Promise<number> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT COUNT(*)::int AS n FROM history_events WHERE type = $1",
      [type],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async listRecentModelCalls(limit = 200): Promise<ModelCallRecord[]> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM model_calls ORDER BY started_at DESC LIMIT $1",
      [limit],
    );
    return result.rows.map(mapModelCall);
  }

  async listRecentToolCalls(limit = 200): Promise<ToolCallRecord[]> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM tool_calls ORDER BY started_at DESC LIMIT $1",
      [limit],
    );
    return result.rows.map(mapToolCall);
  }

  async listRecentAgentRuns(limit = 200): Promise<AgentRunRecord[]> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT $1",
      [limit],
    );
    return result.rows.map(mapAgentRun);
  }

  async insertDeterministicValue(input: {
    runId: string;
    kind: string;
    occurrence: number;
    value: unknown;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO deterministic_values (id, run_id, kind, occurrence, value)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (run_id, kind, occurrence) DO NOTHING`,
      [randomUUID(), input.runId, input.kind, input.occurrence, jsonParam(toJson(input.value))],
    );
  }

  async getDeterministicValue(runId: string, kind: string, occurrence: number): Promise<unknown | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT value FROM deterministic_values WHERE run_id = $1 AND kind = $2 AND occurrence = $3",
      [runId, kind, occurrence],
    );
    if (!result.rows[0]) {
      return null;
    }
    return parseJson(result.rows[0].value);
  }

  async listDeterministicValues(runId: string): Promise<Array<{ kind: string; occurrence: number; value: unknown }>> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT kind, occurrence, value FROM deterministic_values WHERE run_id = $1 ORDER BY kind, occurrence",
      [runId],
    );
    return result.rows.map((row) => ({
      kind: String(row.kind),
      occurrence: Number(row.occurrence),
      value: parseJson(row.value),
    }));
  }

  async insertReplayRecord(input: {
    runId: string;
    recordedVersion: string;
    testedVersion: string;
    status: string;
    eventsReplayed: number;
    durationMs: number;
    divergences: unknown;
  }): Promise<string> {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO replay_records (id, run_id, recorded_version, tested_version, status, events_replayed, duration_ms, divergences)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        id,
        input.runId,
        input.recordedVersion,
        input.testedVersion,
        input.status,
        input.eventsReplayed,
        input.durationMs,
        jsonParam(toJson(input.divergences)),
      ],
    );
    return id;
  }

  async listReplayRecords(runId: string): Promise<
    Array<{
      id: string;
      runId: string;
      recordedVersion: string;
      testedVersion: string;
      status: string;
      eventsReplayed: number;
      durationMs: number | null;
      divergences: unknown;
      createdAt: string | null;
    }>
  > {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM replay_records WHERE run_id = $1 ORDER BY created_at DESC",
      [runId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      recordedVersion: String(row.recorded_version),
      testedVersion: String(row.tested_version),
      status: String(row.status),
      eventsReplayed: Number(row.events_replayed ?? 0),
      durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
      divergences: parseJson(row.divergences),
      createdAt: toIso(row.created_at as Date | string | null),
    }));
  }

  async replayStats(): Promise<{ attempts: number; successes: number; divergences: number; durations: number[] }> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT status, duration_ms FROM replay_records",
    );
    let successes = 0;
    let divergences = 0;
    const durations: number[] = [];
    for (const row of result.rows) {
      if (String(row.status) === "ok") {
        successes += 1;
      } else if (String(row.status) === "divergent") {
        divergences += 1;
      }
      if (row.duration_ms !== null && row.duration_ms !== undefined) {
        durations.push(Number(row.duration_ms));
      }
    }
    return { attempts: result.rows.length, successes, divergences, durations };
  }

  async listVersionCounts(): Promise<Array<{ workflowName: string; version: string; count: number }>> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT workflow_name, workflow_version, COUNT(*)::int AS n
       FROM workflow_runs
       GROUP BY workflow_name, workflow_version
       ORDER BY workflow_name, workflow_version`,
    );
    return result.rows.map((row) => ({
      workflowName: String(row.workflow_name),
      version: String(row.workflow_version),
      count: Number(row.n ?? 0),
    }));
  }

  async listActiveVersionCounts(): Promise<Array<{ workflowName: string; version: string; active: number }>> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT workflow_name, workflow_version, COUNT(*)::int AS n
       FROM workflow_runs
       WHERE status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
       GROUP BY workflow_name, workflow_version
       ORDER BY workflow_name, workflow_version`,
    );
    return result.rows.map((row) => ({
      workflowName: String(row.workflow_name),
      version: String(row.workflow_version),
      active: Number(row.n ?? 0),
    }));
  }

  async countWaitingForWorker(): Promise<number> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT COUNT(*)::int AS n FROM workflow_runs WHERE wait_type = 'compatible-worker' AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')",
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async markWaitingForCompatibleWorker(): Promise<void> {
    await this.db.query(
      `UPDATE workflow_runs
       SET wait_type = 'compatible-worker'
       WHERE status IN ('PENDING', 'WAITING')
         AND id IN (
           SELECT w.run_id FROM work_items w
           WHERE w.type = 'execute_run' AND w.completed_at IS NULL AND w.status IN ('pending', 'failed')
         )
         AND NOT EXISTS (
           SELECT 1 FROM workers wk
           WHERE wk.status = 'online'
             AND (
               cardinality(COALESCE(wk.workflow_versions, ARRAY[]::text[])) = 0
               OR (workflow_runs.workflow_name || '@' || workflow_runs.workflow_version) = ANY (wk.workflow_versions)
             )
         )`,
    );
  }

  async enqueueWork(item: {
    id?: string;
    runId: string;
    type: WorkItemType;
    payload?: Json;
    availableAt?: Date | string;
    queue?: string;
    name?: string;
    maxAttempts?: number;
    priority?: number;
    idempotencyKey?: string;
  }): Promise<WorkItem> {
    const id = item.id ?? randomUUID();
    const availableAt =
      item.availableAt instanceof Date
        ? item.availableAt.toISOString()
        : item.availableAt ?? new Date().toISOString();
    if (item.idempotencyKey) {
      const existing = await this.getWorkItemByIdempotency(item.runId, item.idempotencyKey);
      if (existing) {
        return existing;
      }
    }
    try {
      const result = await this.db.query<Record<string, unknown>>(
        `INSERT INTO work_items (
           id, run_id, type, payload, available_at, queue, name, max_attempts, priority, idempotency_key, status
         ) VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6, $7, $8, $9, $10, 'pending')
         RETURNING *`,
        [
          id,
          item.runId,
          item.type,
          jsonParam(item.payload ?? {}),
          availableAt,
          item.queue ?? DEFAULT_TASK_QUEUE,
          item.name ?? null,
          item.maxAttempts ?? 1,
          item.priority ?? 0,
          item.idempotencyKey ?? null,
        ],
      );
      return mapWork(result.rows[0]!);
    } catch (error) {
      if (item.idempotencyKey) {
        const existing = await this.getWorkItemByIdempotency(item.runId, item.idempotencyKey);
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  async getWorkItem(id: string): Promise<WorkItem | null> {
    const result = await this.db.query<Record<string, unknown>>("SELECT * FROM work_items WHERE id = $1", [id]);
    return result.rows[0] ? mapWork(result.rows[0]) : null;
  }

  async getWorkItemByIdempotency(runId: string, idempotencyKey: string): Promise<WorkItem | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM work_items WHERE run_id = $1 AND idempotency_key = $2",
      [runId, idempotencyKey],
    );
    return result.rows[0] ? mapWork(result.rows[0]) : null;
  }

  async claimWork(
    workerId: string,
    opts: { limit: number; leaseMs: number; queues?: string[]; types?: string[]; workflowVersions?: string[] },
  ): Promise<WorkItem[]> {
    const leaseExpires = new Date(Date.now() + opts.leaseMs).toISOString();
    const token = randomUUID();
    const queues = opts.queues?.length ? opts.queues : null;
    const types = opts.types?.length ? opts.types : null;
    const versions = opts.workflowVersions === undefined ? null : opts.workflowVersions;
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE work_items
       SET lease_owner = $1,
           lease_expires_at = $2::timestamptz,
           lease_token = $3,
           status = 'leased',
           attempt = attempt + 1,
           started_at = COALESCE(started_at, now())
       WHERE id IN (
         SELECT id FROM work_items
         WHERE completed_at IS NULL
           AND status IN ('pending', 'leased', 'failed')
           AND available_at <= now()
           AND (lease_expires_at IS NULL OR lease_expires_at < now())
           AND ($5::text[] IS NULL OR queue = ANY($5::text[]))
           AND ($6::text[] IS NULL OR type = ANY($6::text[]))
           AND (
             $7::text[] IS NULL
             OR type <> 'execute_run'
             OR EXISTS (
               SELECT 1 FROM workflow_runs r
               WHERE r.id = work_items.run_id
                 AND (r.workflow_name || '@' || r.workflow_version) = ANY($7::text[])
             )
           )
         ORDER BY priority DESC, available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $4
       )
       RETURNING *`,
      [workerId, leaseExpires, token, opts.limit, queues, types, versions],
    );
    return result.rows.map(mapWork);
  }

  async heartbeatWork(id: string, workerId: string, leaseMs: number, leaseToken?: string): Promise<boolean> {
    const leaseExpires = new Date(Date.now() + leaseMs).toISOString();
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE work_items
       SET lease_expires_at = $3::timestamptz
       WHERE id = $1 AND lease_owner = $2 AND completed_at IS NULL
         AND ($4::text IS NULL OR lease_token = $4)
       RETURNING id`,
      [id, workerId, leaseExpires, leaseToken ?? null],
    );
    return result.rows.length > 0;
  }

  async completeWork(id: string, patch?: { result?: Json | null; leaseToken?: string }): Promise<WorkItem> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE work_items SET
         completed_at = now(),
         status = 'completed',
         result = CASE WHEN $2 THEN $3::jsonb ELSE result END,
         lease_owner = NULL,
         lease_expires_at = NULL
       WHERE id = $1
         AND completed_at IS NULL
         AND ($4::text IS NULL OR lease_token = $4)
       RETURNING *`,
      [
        id,
        patch?.result !== undefined,
        patch?.result !== undefined ? jsonParam(patch.result) : null,
        patch?.leaseToken ?? null,
      ],
    );
    if (!result.rows[0]) {
      const existing = await this.getWorkItem(id);
      if (existing?.status === "completed" && (!patch?.leaseToken || existing.leaseToken === patch.leaseToken)) {
        return existing;
      }
      throw new StaleLeaseError(id);
    }
    const completed = mapWork(result.rows[0]);
    await this.incrementQueueMetric(completed.queue, "completed");
    return completed;
  }

  async failWork(
    id: string,
    error: PersistedError,
    options?: { leaseToken?: string; retryable?: boolean; retryAt?: Date },
  ): Promise<WorkItem> {
    const current = await this.getWorkItem(id);
    if (!current) {
      throw new StaleLeaseError(id);
    }
    if (options?.leaseToken && current.leaseToken && current.leaseToken !== options.leaseToken) {
      throw new StaleLeaseError(id);
    }
    if (current.status === "completed") {
      throw new StaleLeaseError(id);
    }
    const retry = Boolean(options?.retryable) && current.attempt < current.maxAttempts;
    if (retry) {
      const retryAt = (options?.retryAt ?? new Date()).toISOString();
      const result = await this.db.query<Record<string, unknown>>(
        `UPDATE work_items SET
           status = 'pending',
           error = $2::jsonb,
           lease_owner = NULL,
           lease_expires_at = NULL,
           lease_token = NULL,
           available_at = $3::timestamptz,
           completed_at = NULL
         WHERE id = $1 AND ($4::text IS NULL OR lease_token = $4 OR lease_token IS NULL)
         RETURNING *`,
        [id, jsonParam(error), retryAt, options?.leaseToken ?? null],
      );
      if (!result.rows[0]) {
        throw new StaleLeaseError(id);
      }
      await this.incrementQueueMetric(current.queue, "retries");
      return mapWork(result.rows[0]);
    }
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE work_items SET
         status = 'dead',
         error = $2::jsonb,
         completed_at = now(),
         lease_owner = NULL,
         lease_expires_at = NULL
       WHERE id = $1 AND ($3::text IS NULL OR lease_token = $3)
       RETURNING *`,
      [id, jsonParam(error), options?.leaseToken ?? null],
    );
    if (!result.rows[0]) {
      throw new StaleLeaseError(id);
    }
    await this.incrementQueueMetric(current.queue, "failed");
    return mapWork(result.rows[0]);
  }

  async updateWorkProgress(id: string, leaseToken: string, progress: Json): Promise<boolean> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE work_items SET progress = $3::jsonb
       WHERE id = $1 AND lease_token = $2 AND completed_at IS NULL
       RETURNING id`,
      [id, leaseToken, jsonParam(progress)],
    );
    return result.rows.length > 0;
  }

  async expireWorkLease(id: string): Promise<void> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE work_items
       SET lease_owner = NULL, lease_expires_at = now() - interval '1 second', lease_token = NULL, status = 'pending'
       WHERE id = $1 AND completed_at IS NULL
       RETURNING queue`,
      [id],
    );
    if (result.rows[0]) {
      await this.incrementQueueMetric(String(result.rows[0].queue), "lease_expirations");
    }
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE work_items
       SET status = 'pending', lease_owner = NULL, lease_token = NULL
       WHERE completed_at IS NULL AND status = 'leased' AND lease_expires_at < now()
       RETURNING queue`,
    );
    for (const row of result.rows) {
      await this.incrementQueueMetric(String(row.queue), "lease_expirations");
    }
    return result.rows.length;
  }

  async incrementQueueMetric(
    queue: string,
    field: "completed" | "failed" | "retries" | "lease_expirations",
    amount = 1,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO queue_metrics (queue, ${field}) VALUES ($1, $2)
       ON CONFLICT (queue) DO UPDATE SET ${field} = queue_metrics.${field} + $2`,
      [queue, amount],
    );
  }

  async getQueueMetrics(): Promise<
    Array<{
      queue: string;
      pending: number;
      leased: number;
      completed: number;
      failed: number;
      retries: number;
      leaseExpirations: number;
      oldestPendingAgeMs: number | null;
    }>
  > {
    const counts = await this.db.query<Record<string, unknown>>(
      `SELECT queue,
              COUNT(*) FILTER (WHERE completed_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at < now())) AS pending,
              COUNT(*) FILTER (WHERE completed_at IS NULL AND lease_expires_at IS NOT NULL AND lease_expires_at >= now()) AS leased,
              EXTRACT(EPOCH FROM (now() - MIN(available_at) FILTER (WHERE completed_at IS NULL AND available_at <= now()))) * 1000 AS oldest_ms
       FROM work_items
       GROUP BY queue`,
    );
    const totals = await this.db.query<Record<string, unknown>>("SELECT * FROM queue_metrics");
    const queues = new Set<string>([
      ...counts.rows.map((row) => String(row.queue)),
      ...totals.rows.map((row) => String(row.queue)),
    ]);
    const byQueue = new Map(totals.rows.map((row) => [String(row.queue), row]));
    return [...queues].sort().map((queue) => {
      const live = counts.rows.find((row) => String(row.queue) === queue);
      const metric = byQueue.get(queue);
      return {
        queue,
        pending: Number(live?.pending ?? 0),
        leased: Number(live?.leased ?? 0),
        completed: Number(metric?.completed ?? 0),
        failed: Number(metric?.failed ?? 0),
        retries: Number(metric?.retries ?? 0),
        leaseExpirations: Number(metric?.lease_expirations ?? 0),
        oldestPendingAgeMs: live?.oldest_ms === null || live?.oldest_ms === undefined ? null : Number(live.oldest_ms),
      };
    });
  }

  async listWorkers(): Promise<
    Array<{
      id: string;
      lastHeartbeat: string;
      metadata: Json;
      queues: string[];
      capabilities: string[];
      concurrency: number;
      status: string;
      version: string | null;
      availableSlots: number | null;
      activeTasks: number;
      startedAt: string | null;
      workflowVersions: string[];
    }>
  > {
    const result = await this.db.query<Record<string, unknown>>("SELECT * FROM workers ORDER BY id");
    return result.rows.map((row) => ({
      id: String(row.id),
      lastHeartbeat: requiredIso(row.last_heartbeat as Date | string),
      metadata: parseJson(row.metadata),
      queues: Array.isArray(row.queues) ? row.queues.map(String) : [DEFAULT_TASK_QUEUE],
      capabilities: Array.isArray(row.capabilities) ? row.capabilities.map(String) : [],
      concurrency: Number(row.concurrency ?? 1),
      status: String(row.status ?? "online"),
      version: row.version ? String(row.version) : null,
      availableSlots: row.available_slots === null || row.available_slots === undefined ? null : Number(row.available_slots),
      activeTasks: Number(row.active_tasks ?? 0),
      startedAt: toIso(row.started_at as Date | string | null),
      workflowVersions: Array.isArray(row.workflow_versions) ? row.workflow_versions.map(String) : [],
    }));
  }

  async upsertWorker(
    id: string,
    metadata: Json = {},
    extra?: {
      queues?: string[];
      capabilities?: string[];
      workflowVersions?: string[];
      concurrency?: number;
      status?: string;
      version?: string;
      protocolVersion?: string;
      hostname?: string;
      processId?: number;
      availableSlots?: number;
      activeTasks?: number;
    },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO workers (
         id, last_heartbeat, metadata, queues, capabilities, concurrency, status, version, protocol_version,
         hostname, process_id, started_at, available_slots, active_tasks, workflow_versions
       ) VALUES (
         $1, now(), $2::jsonb, $3::text[], $4::text[], $5, $6, $7, $8, $9, $10, now(), $11, $12, $13::text[]
       )
       ON CONFLICT (id) DO UPDATE SET
         last_heartbeat = now(),
         metadata = EXCLUDED.metadata,
         queues = EXCLUDED.queues,
         capabilities = EXCLUDED.capabilities,
         concurrency = EXCLUDED.concurrency,
         status = EXCLUDED.status,
         version = EXCLUDED.version,
         protocol_version = EXCLUDED.protocol_version,
         hostname = EXCLUDED.hostname,
         process_id = EXCLUDED.process_id,
         available_slots = EXCLUDED.available_slots,
         active_tasks = EXCLUDED.active_tasks,
         workflow_versions = EXCLUDED.workflow_versions`,
      [
        id,
        jsonParam(metadata),
        extra?.queues ?? [DEFAULT_TASK_QUEUE],
        extra?.capabilities ?? [],
        extra?.concurrency ?? 1,
        extra?.status ?? "online",
        extra?.version ?? null,
        extra?.protocolVersion ?? "1",
        extra?.hostname ?? null,
        extra?.processId ?? null,
        extra?.availableSlots ?? extra?.concurrency ?? 1,
        extra?.activeTasks ?? 0,
        extra?.workflowVersions ?? [],
      ],
    );
  }

  async heartbeatWorker(
    id: string,
    extra?: { availableSlots?: number; activeTasks?: number; status?: string; workflowVersions?: string[] },
  ): Promise<void> {
    await this.db.query(
      `UPDATE workers SET
         last_heartbeat = now(),
         available_slots = COALESCE($2, available_slots),
         active_tasks = COALESCE($3, active_tasks),
         status = COALESCE($4, status),
         workflow_versions = COALESCE($5::text[], workflow_versions)
       WHERE id = $1`,
      [
        id,
        extra?.availableSlots ?? null,
        extra?.activeTasks ?? null,
        extra?.status ?? null,
        extra?.workflowVersions ?? null,
      ],
    );
  }

  async createTimer(timer: {
    id?: string;
    runId: string;
    stepRunId: string;
    fireAt: Date | string;
  }): Promise<DurableTimer> {
    const id = timer.id ?? randomUUID();
    const fireAt = timer.fireAt instanceof Date ? timer.fireAt.toISOString() : timer.fireAt;
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO timers (id, run_id, step_run_id, fire_at, status)
       VALUES ($1, $2, $3, $4::timestamptz, 'pending')
       RETURNING *`,
      [id, timer.runId, timer.stepRunId, fireAt],
    );
    return mapTimer(result.rows[0]!);
  }

  async getTimerByStep(stepRunId: string): Promise<DurableTimer | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM timers WHERE step_run_id = $1",
      [stepRunId],
    );
    return result.rows[0] ? mapTimer(result.rows[0]) : null;
  }

  async fireTimer(id: string): Promise<DurableTimer | null> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE timers
       SET status = 'fired', fired_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id],
    );
    return result.rows[0] ? mapTimer(result.rows[0]) : null;
  }

  async listDueTimers(limit = 20): Promise<DurableTimer[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM timers
       WHERE status = 'pending' AND fire_at <= now()
       ORDER BY fire_at
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapTimer);
  }

  async cancelPendingTimers(runId: string): Promise<void> {
    await this.db.query(
      `UPDATE timers SET status = 'cancelled' WHERE run_id = $1 AND status = 'pending'`,
      [runId],
    );
  }

  async appendEvent(event: {
    id?: string;
    runId: string;
    type: string;
    data: unknown;
    deliveryId?: string | null;
  }): Promise<ExternalEvent> {
    const id = event.id ?? randomUUID();
    try {
      const result = await this.db.query<Record<string, unknown>>(
        `INSERT INTO external_events (id, run_id, type, data, delivery_id)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING *`,
        [id, event.runId, event.type, jsonParam(toJson(event.data)), event.deliveryId ?? null],
      );
      return mapEvent(result.rows[0]!);
    } catch (error) {
      if (event.deliveryId) {
        const existing = await this.db.query<Record<string, unknown>>(
          "SELECT * FROM external_events WHERE run_id = $1 AND delivery_id = $2",
          [event.runId, event.deliveryId],
        );
        if (existing.rows[0]) {
          return mapEvent(existing.rows[0]);
        }
      }
      throw error;
    }
  }

  async findUnconsumedEvent(runId: string, type: string): Promise<ExternalEvent | null> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM external_events
       WHERE run_id = $1 AND type = $2 AND consumed_at IS NULL
       ORDER BY received_at ASC, id ASC
       LIMIT 1`,
      [runId, type],
    );
    return result.rows[0] ? mapEvent(result.rows[0]) : null;
  }

  async consumeEvent(id: string, stepId: string): Promise<ExternalEvent | null> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE external_events
       SET consumed_at = now(), consumed_by_step_id = $2
       WHERE id = $1 AND consumed_at IS NULL
       RETURNING *`,
      [id, stepId],
    );
    return result.rows[0] ? mapEvent(result.rows[0]) : null;
  }

  async listEvents(runId: string): Promise<ExternalEvent[]> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM external_events WHERE run_id = $1 ORDER BY received_at",
      [runId],
    );
    return result.rows.map(mapEvent);
  }

  async createHumanTask(task: {
    id?: string;
    runId: string;
    stepRunId: string;
    name: string;
    occurrence: number;
    title: string;
    assignedTo?: string | null;
    data?: unknown;
  }): Promise<HumanTask> {
    const id = task.id ?? randomUUID();
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO human_tasks (
         id, run_id, step_run_id, name, occurrence, title, assigned_to, data, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'pending')
       RETURNING *`,
      [
        id,
        task.runId,
        task.stepRunId,
        task.name,
        task.occurrence,
        task.title,
        task.assignedTo ?? null,
        jsonParam(task.data ?? null),
      ],
    );
    return mapHuman(result.rows[0]!);
  }

  async getHumanTask(id: string): Promise<HumanTask | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM human_tasks WHERE id = $1",
      [id],
    );
    return result.rows[0] ? mapHuman(result.rows[0]) : null;
  }

  async getHumanTaskByStep(stepRunId: string): Promise<HumanTask | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM human_tasks WHERE step_run_id = $1",
      [stepRunId],
    );
    return result.rows[0] ? mapHuman(result.rows[0]) : null;
  }

  async listHumanTasks(filter?: { status?: HumanTaskStatus; runId?: string }): Promise<HumanTask[]> {
    if (filter?.status && filter.runId) {
      const result = await this.db.query<Record<string, unknown>>(
        "SELECT * FROM human_tasks WHERE status = $1 AND run_id = $2 ORDER BY created_at DESC",
        [filter.status, filter.runId],
      );
      return result.rows.map(mapHuman);
    }
    if (filter?.status) {
      const result = await this.db.query<Record<string, unknown>>(
        "SELECT * FROM human_tasks WHERE status = $1 ORDER BY created_at DESC",
        [filter.status],
      );
      return result.rows.map(mapHuman);
    }
    if (filter?.runId) {
      const result = await this.db.query<Record<string, unknown>>(
        "SELECT * FROM human_tasks WHERE run_id = $1 ORDER BY created_at DESC",
        [filter.runId],
      );
      return result.rows.map(mapHuman);
    }
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM human_tasks ORDER BY created_at DESC LIMIT 100",
    );
    return result.rows.map(mapHuman);
  }

  async completeHumanTask(id: string, response: unknown): Promise<HumanTask | null> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE human_tasks
       SET status = 'completed', response = $2::jsonb, completed_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id, jsonParam(toJson(response))],
    );
    return result.rows[0] ? mapHuman(result.rows[0]) : null;
  }

  async cancelTimer(id: string): Promise<void> {
    await this.db.query(
      `UPDATE timers SET status = 'cancelled' WHERE id = $1 AND status = 'pending'`,
      [id],
    );
  }

  async cancelPendingHumanTasks(runId: string): Promise<void> {
    await this.db.query(
      `UPDATE human_tasks SET status = 'cancelled' WHERE run_id = $1 AND status = 'pending'`,
      [runId],
    );
  }

  async createInteraction(input: {
    id?: string;
    runId: string;
    stepRunId: string;
    interactionId: string;
    type?: string;
    title: string;
    description?: string | null;
    metadata?: unknown;
  }): Promise<HumanInteraction> {
    const id = input.id ?? randomUUID();
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO human_interactions (
         id, run_id, step_run_id, interaction_id, type, title, description, status, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8::jsonb)
       RETURNING *`,
      [
        id,
        input.runId,
        input.stepRunId,
        input.interactionId,
        input.type ?? "approval",
        input.title,
        input.description ?? null,
        jsonParam(input.metadata ?? null),
      ],
    );
    return mapInteraction(result.rows[0]!);
  }

  async getInteractionByStep(stepRunId: string): Promise<HumanInteraction | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM human_interactions WHERE step_run_id = $1",
      [stepRunId],
    );
    return result.rows[0] ? mapInteraction(result.rows[0]) : null;
  }

  async getInteraction(runId: string, interactionId: string): Promise<HumanInteraction | null> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM human_interactions
       WHERE run_id = $1 AND interaction_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [runId, interactionId],
    );
    return result.rows[0] ? mapInteraction(result.rows[0]) : null;
  }

  async getPendingInteraction(runId: string, interactionId: string): Promise<HumanInteraction | null> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM human_interactions
       WHERE run_id = $1 AND interaction_id = $2 AND status = 'pending'
       ORDER BY created_at
       LIMIT 1`,
      [runId, interactionId],
    );
    return result.rows[0] ? mapInteraction(result.rows[0]) : null;
  }

  async listInteractions(filter?: {
    runId?: string;
    status?: HumanInteractionStatus;
  }): Promise<HumanInteraction[]> {
    if (filter?.runId && filter.status) {
      const result = await this.db.query<Record<string, unknown>>(
        "SELECT * FROM human_interactions WHERE run_id = $1 AND status = $2 ORDER BY created_at DESC",
        [filter.runId, filter.status],
      );
      return result.rows.map(mapInteraction);
    }
    if (filter?.runId) {
      const result = await this.db.query<Record<string, unknown>>(
        "SELECT * FROM human_interactions WHERE run_id = $1 ORDER BY created_at DESC",
        [filter.runId],
      );
      return result.rows.map(mapInteraction);
    }
    if (filter?.status) {
      const result = await this.db.query<Record<string, unknown>>(
        "SELECT * FROM human_interactions WHERE status = $1 ORDER BY created_at DESC",
        [filter.status],
      );
      return result.rows.map(mapInteraction);
    }
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM human_interactions ORDER BY created_at DESC LIMIT 100",
    );
    return result.rows.map(mapInteraction);
  }

  async completeInteraction(
    id: string,
    status: Exclude<HumanInteractionStatus, "pending">,
    decision: HumanDecision,
  ): Promise<HumanInteraction | null> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE human_interactions
       SET status = $2, decision = $3::jsonb, completed_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id, status, jsonParam(toJson(decision))],
    );
    return result.rows[0] ? mapInteraction(result.rows[0]) : null;
  }

  async cancelPendingInteractions(runId: string): Promise<HumanInteraction[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE human_interactions
       SET status = 'cancelled', completed_at = now()
       WHERE run_id = $1 AND status = 'pending'
       RETURNING *`,
      [runId],
    );
    return result.rows.map(mapInteraction);
  }

  async insertAgentExecution(exec: {
    id?: string;
    stepRunId: string;
    runId: string;
    provider: string;
    model?: string | null;
    messages?: Json | null;
    tokenInput?: number | null;
    tokenOutput?: number | null;
    durationMs?: number | null;
  }): Promise<AgentExecution> {
    const id = exec.id ?? randomUUID();
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO agent_executions (
         id, step_run_id, run_id, provider, model, messages, token_input, token_output, duration_ms
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
       RETURNING *`,
      [
        id,
        exec.stepRunId,
        exec.runId,
        exec.provider,
        exec.model ?? null,
        jsonParam(exec.messages ?? null),
        exec.tokenInput ?? null,
        exec.tokenOutput ?? null,
        exec.durationMs ?? null,
      ],
    );
    return mapAgent(result.rows[0]!);
  }

  async listAgentExecutions(runId: string): Promise<AgentExecution[]> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM agent_executions WHERE run_id = $1",
      [runId],
    );
    return result.rows.map(mapAgent);
  }

  async insertToolInvocation(inv: {
    id?: string;
    stepRunId: string;
    runId: string;
    name: string;
    input: unknown;
  }): Promise<ToolInvocation> {
    const id = inv.id ?? randomUUID();
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO tool_invocations (id, step_run_id, run_id, name, input)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       RETURNING *`,
      [id, inv.stepRunId, inv.runId, inv.name, jsonParam(toJson(inv.input))],
    );
    return mapTool(result.rows[0]!);
  }

  async completeToolInvocation(
    id: string,
    output: unknown,
    error?: PersistedError | null,
  ): Promise<ToolInvocation> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE tool_invocations
       SET output = $2::jsonb, error = $3::jsonb, completed_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, jsonParam(toJson(output)), error ? jsonParam(error) : null],
    );
    return mapTool(result.rows[0]!);
  }

  async listToolInvocations(runId: string): Promise<ToolInvocation[]> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM tool_invocations WHERE run_id = $1 ORDER BY started_at",
      [runId],
    );
    return result.rows.map(mapTool);
  }

  async listTimers(runId: string): Promise<DurableTimer[]> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM timers WHERE run_id = $1 ORDER BY fire_at",
      [runId],
    );
    return result.rows.map(mapTimer);
  }

  async listChildren(parentRunId: string): Promise<WorkflowRun[]> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM workflow_runs WHERE parent_run_id = $1 ORDER BY created_at",
      [parentRunId],
    );
    return result.rows.map(mapRun);
  }

  async getChildByStep(parentStepId: string): Promise<WorkflowRun | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM workflow_runs WHERE parent_step_id = $1 LIMIT 1",
      [parentStepId],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async insertAgentRun(run: {
    id?: string;
    runId: string;
    stepRunId: string;
    agentName: string;
    status?: AgentRunStatus;
    limits?: AgentLimits;
    parentAgentRunId?: string | null;
    parentExecutionId?: string | null;
    rootExecutionId?: string | null;
    depth?: number;
    failurePolicy?: "fail-parent" | "return-error";
    cancellationPolicy?: "propagate" | "detach";
  }): Promise<AgentRunRecord> {
    const id = run.id ?? randomUUID();
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO agent_runs (
         id, run_id, step_run_id, agent_name, status, limits,
         parent_agent_run_id, parent_execution_id, root_execution_id, depth,
         failure_policy, cancellation_policy
       )
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        id,
        run.runId,
        run.stepRunId,
        run.agentName,
        run.status ?? "RUNNING",
        jsonParam(run.limits ?? {}),
        run.parentAgentRunId ?? null,
        run.parentExecutionId ?? run.runId,
        run.rootExecutionId ?? run.runId,
        run.depth ?? 0,
        run.failurePolicy ?? "fail-parent",
        run.cancellationPolicy ?? "propagate",
      ],
    );
    return mapAgentRun(result.rows[0]!);
  }

  async getAgentRunByStep(stepRunId: string): Promise<AgentRunRecord | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM agent_runs WHERE step_run_id = $1 ORDER BY started_at DESC LIMIT 1",
      [stepRunId],
    );
    return result.rows[0] ? mapAgentRun(result.rows[0]) : null;
  }

  async getAgentRun(id: string): Promise<AgentRunRecord | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM agent_runs WHERE id = $1",
      [id],
    );
    return result.rows[0] ? mapAgentRun(result.rows[0]) : null;
  }

  async listAgentRuns(runId: string): Promise<AgentRunRecord[]> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM agent_runs WHERE run_id = $1 ORDER BY started_at",
      [runId],
    );
    return result.rows.map(mapAgentRun);
  }

  async updateAgentRun(id: string, patch: {
    status?: AgentRunStatus;
    currentTurn?: number;
    toolCallCount?: number;
    modelCallCount?: number;
    output?: Json | null;
    error?: PersistedError | null;
    completedAt?: string | null;
  }): Promise<AgentRunRecord> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE agent_runs SET
         status = COALESCE($2, status),
         current_turn = COALESCE($3, current_turn),
         tool_call_count = COALESCE($4, tool_call_count),
         model_call_count = COALESCE($5, model_call_count),
         output = CASE WHEN $6 THEN $7::jsonb ELSE output END,
         error = CASE WHEN $8 THEN $9::jsonb ELSE error END,
         completed_at = COALESCE($10::timestamptz, completed_at)
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.status ?? null,
        patch.currentTurn ?? null,
        patch.toolCallCount ?? null,
        patch.modelCallCount ?? null,
        patch.output !== undefined,
        patch.output !== undefined ? jsonParam(patch.output) : null,
        patch.error !== undefined,
        patch.error !== undefined ? jsonParam(patch.error) : null,
        patch.completedAt ?? null,
      ],
    );
    return mapAgentRun(result.rows[0]!);
  }

  async insertAgentTurn(turn: {
    id?: string;
    agentRunId: string;
    runId: string;
    turnNumber: number;
    inputMessages?: Json | null;
  }): Promise<AgentTurnRecord> {
    const id = turn.id ?? randomUUID();
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO agent_turns (id, agent_run_id, run_id, turn_number, input_messages)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       RETURNING *`,
      [id, turn.agentRunId, turn.runId, turn.turnNumber, jsonParam(turn.inputMessages ?? null)],
    );
    return mapAgentTurn(result.rows[0]!);
  }

  async listAgentTurns(agentRunId: string): Promise<AgentTurnRecord[]> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM agent_turns WHERE agent_run_id = $1 ORDER BY turn_number",
      [agentRunId],
    );
    return result.rows.map(mapAgentTurn);
  }

  async updateAgentTurn(id: string, patch: {
    outputMessages?: Json | null;
    requestedTools?: Json | null;
    error?: PersistedError | null;
    completedAt?: string | null;
  }): Promise<AgentTurnRecord> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE agent_turns SET
         output_messages = CASE WHEN $2 THEN $3::jsonb ELSE output_messages END,
         requested_tools = CASE WHEN $4 THEN $5::jsonb ELSE requested_tools END,
         error = CASE WHEN $6 THEN $7::jsonb ELSE error END,
         completed_at = COALESCE($8::timestamptz, completed_at)
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.outputMessages !== undefined,
        patch.outputMessages !== undefined ? jsonParam(patch.outputMessages) : null,
        patch.requestedTools !== undefined,
        patch.requestedTools !== undefined ? jsonParam(patch.requestedTools) : null,
        patch.error !== undefined,
        patch.error !== undefined ? jsonParam(patch.error) : null,
        patch.completedAt ?? null,
      ],
    );
    return mapAgentTurn(result.rows[0]!);
  }

  async insertModelCall(call: {
    id?: string;
    agentRunId: string;
    agentTurnId: string;
    runId: string;
    provider: string;
    model?: string | null;
    request?: Json | null;
    attempt?: number;
  }): Promise<ModelCallRecord> {
    const id = call.id ?? randomUUID();
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO model_calls (id, agent_run_id, agent_turn_id, run_id, provider, model, request, attempt)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       RETURNING *`,
      [
        id,
        call.agentRunId,
        call.agentTurnId,
        call.runId,
        call.provider,
        call.model ?? null,
        jsonParam(call.request ?? null),
        call.attempt ?? 1,
      ],
    );
    return mapModelCall(result.rows[0]!);
  }

  async listModelCalls(agentRunId: string): Promise<ModelCallRecord[]> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM model_calls WHERE agent_run_id = $1 ORDER BY started_at",
      [agentRunId],
    );
    return result.rows.map(mapModelCall);
  }

  async completeModelCall(id: string, patch: {
    response?: Json | null;
    tokenInput?: number | null;
    tokenOutput?: number | null;
    latencyMs?: number | null;
    stopReason?: string | null;
    error?: PersistedError | null;
  }): Promise<ModelCallRecord> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE model_calls SET
         response = $2::jsonb,
         token_input = $3,
         token_output = $4,
         latency_ms = $5,
         stop_reason = $6,
         error = $7::jsonb,
         completed_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        jsonParam(patch.response ?? null),
        patch.tokenInput ?? null,
        patch.tokenOutput ?? null,
        patch.latencyMs ?? null,
        patch.stopReason ?? null,
        patch.error ? jsonParam(patch.error) : null,
      ],
    );
    return mapModelCall(result.rows[0]!);
  }

  async insertToolCall(call: {
    id?: string;
    agentRunId: string;
    agentTurnId?: string | null;
    runId: string;
    name: string;
    source?: ToolSource;
    server?: string | null;
    arguments?: Json | null;
    attempt?: number;
    idempotencyKey?: string | null;
  }): Promise<ToolCallRecord> {
    const id = call.id ?? randomUUID();
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO tool_calls (
         id, agent_run_id, agent_turn_id, run_id, name, source, server, arguments, status, attempt, idempotency_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'PENDING',$9,$10)
       RETURNING *`,
      [
        id,
        call.agentRunId,
        call.agentTurnId ?? null,
        call.runId,
        call.name,
        call.source ?? "local",
        call.server ?? null,
        jsonParam(call.arguments ?? null),
        call.attempt ?? 1,
        call.idempotencyKey ?? null,
      ],
    );
    return mapToolCall(result.rows[0]!);
  }

  async listToolCalls(filter: { agentRunId?: string; runId?: string; id?: string }): Promise<ToolCallRecord[]> {
    if (filter.id) {
      const result = await this.db.query<Record<string, unknown>>(
        "SELECT * FROM tool_calls WHERE id = $1",
        [filter.id],
      );
      return result.rows.map(mapToolCall);
    }
    if (filter.agentRunId) {
      const result = await this.db.query<Record<string, unknown>>(
        "SELECT * FROM tool_calls WHERE agent_run_id = $1 ORDER BY started_at",
        [filter.agentRunId],
      );
      return result.rows.map(mapToolCall);
    }
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM tool_calls WHERE run_id = $1 ORDER BY started_at",
      [filter.runId],
    );
    return result.rows.map(mapToolCall);
  }

  async getToolCall(id: string): Promise<ToolCallRecord | null> {
    const rows = await this.listToolCalls({ id });
    return rows[0] ?? null;
  }

  async listModelCallsForRun(runId: string): Promise<ModelCallRecord[]> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM model_calls WHERE run_id = $1 ORDER BY started_at",
      [runId],
    );
    return result.rows.map(mapModelCall);
  }

  async cancelOpenAgentRuns(runId: string): Promise<string[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE agent_runs
       SET status = 'CANCELLED', completed_at = now()
       WHERE run_id = $1
         AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
       RETURNING id`,
      [runId],
    );
    return result.rows.map((row) => String(row.id));
  }

  async listWaitingParentsWithTerminalChildren(): Promise<WorkflowRun[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT DISTINCT p.*
       FROM workflow_runs p
       JOIN workflow_runs c ON c.parent_run_id = p.id
       WHERE p.status = 'WAITING'
         AND c.status IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
    );
    return result.rows.map(mapRun);
  }

  async listAgentRunsByParent(parentAgentRunId: string): Promise<AgentRunRecord[]> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM agent_runs WHERE parent_agent_run_id = $1 ORDER BY started_at",
      [parentAgentRunId],
    );
    return result.rows.map(mapAgentRun);
  }

  async listAgentRunsByParentExecution(parentExecutionId: string): Promise<AgentRunRecord[]> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM agent_runs WHERE parent_execution_id = $1 ORDER BY started_at",
      [parentExecutionId],
    );
    return result.rows.map(mapAgentRun);
  }

  async countDirectChildren(parentExecutionId: string): Promise<number> {
    const workflows = await this.db.query<{ count: string | number }>(
      "SELECT COUNT(*)::int AS count FROM workflow_runs WHERE parent_run_id = $1",
      [parentExecutionId],
    );
    const agents = await this.db.query<{ count: string | number }>(
      "SELECT COUNT(*)::int AS count FROM agent_runs WHERE parent_execution_id = $1",
      [parentExecutionId],
    );
    return Number(workflows.rows[0]?.count ?? 0) + Number(agents.rows[0]?.count ?? 0);
  }

  async countTreeExecutions(rootExecutionId: string): Promise<number> {
    const workflows = await this.db.query<{ count: string | number }>(
      "SELECT COUNT(*)::int AS count FROM workflow_runs WHERE root_run_id = $1 OR id = $1",
      [rootExecutionId],
    );
    const agents = await this.db.query<{ count: string | number }>(
      "SELECT COUNT(*)::int AS count FROM agent_runs WHERE root_execution_id = $1",
      [rootExecutionId],
    );
    return Number(workflows.rows[0]?.count ?? 0) + Number(agents.rows[0]?.count ?? 0);
  }

  async listTimedOutRuns(nowIso: string): Promise<WorkflowRun[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM workflow_runs
       WHERE timeout_at IS NOT NULL
         AND timeout_at <= $1::timestamptz
         AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
       ORDER BY timeout_at
       LIMIT 25`,
      [nowIso],
    );
    return result.rows.map(mapRun);
  }

  async listDescendantAgentRuns(agentRunId: string): Promise<AgentRunRecord[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `WITH RECURSIVE tree AS (
         SELECT * FROM agent_runs WHERE parent_agent_run_id = $1
         UNION ALL
         SELECT child.* FROM agent_runs child
         JOIN tree ON child.parent_agent_run_id = tree.id
       )
       SELECT * FROM tree`,
      [agentRunId],
    );
    return result.rows.map(mapAgentRun);
  }

  async insertRemoteOperation(input: {
    id?: string;
    runId: string;
    stepRunId?: string | null;
    capabilityId: string;
    provider: string;
    endpointRef: string;
    remoteTaskId?: string | null;
    clientRequestId: string;
    status?: RemoteOperationStatus;
    attempt?: number;
    protocolVersion?: string;
    correlation?: unknown;
  }): Promise<RemoteOperation> {
    const id = input.id ?? randomUUID();
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO remote_operations (
         id, run_id, step_run_id, capability_id, provider, endpoint_ref,
         remote_task_id, client_request_id, status, attempt, protocol_version, correlation
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       ON CONFLICT (run_id, client_request_id) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [
        id,
        input.runId,
        input.stepRunId ?? null,
        input.capabilityId,
        input.provider,
        input.endpointRef,
        input.remoteTaskId ?? null,
        input.clientRequestId,
        input.status ?? "PENDING",
        input.attempt ?? 1,
        input.protocolVersion ?? "1",
        jsonParam(toJson(input.correlation ?? {})),
      ],
    );
    return mapRemoteOperation(result.rows[0]!);
  }

  async getRemoteOperationByRequest(runId: string, clientRequestId: string): Promise<RemoteOperation | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM remote_operations WHERE run_id = $1 AND client_request_id = $2",
      [runId, clientRequestId],
    );
    return result.rows[0] ? mapRemoteOperation(result.rows[0]) : null;
  }

  async getRemoteOperation(id: string): Promise<RemoteOperation | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM remote_operations WHERE id = $1",
      [id],
    );
    return result.rows[0] ? mapRemoteOperation(result.rows[0]) : null;
  }

  async listRemoteOperations(runId: string): Promise<RemoteOperation[]> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM remote_operations WHERE run_id = $1 ORDER BY created_at",
      [runId],
    );
    return result.rows.map(mapRemoteOperation);
  }

  async listOpenRemoteOperations(): Promise<RemoteOperation[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM remote_operations
       WHERE status IN ('PENDING', 'SENDING', 'WORKING')
       ORDER BY created_at`,
    );
    return result.rows.map(mapRemoteOperation);
  }

  async updateRemoteOperation(
    id: string,
    patch: {
      status?: RemoteOperationStatus;
      remoteTaskId?: string | null;
      attempt?: number;
      correlation?: unknown;
      result?: Json | null;
      error?: PersistedError | null;
      completedAt?: string | null;
    },
  ): Promise<RemoteOperation> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE remote_operations SET
         status = COALESCE($2, status),
         remote_task_id = COALESCE($3, remote_task_id),
         attempt = COALESCE($4, attempt),
         correlation = CASE WHEN $5 THEN $6::jsonb ELSE correlation END,
         result = CASE WHEN $7 THEN $8::jsonb ELSE result END,
         error = CASE WHEN $9 THEN $10::jsonb ELSE error END,
         completed_at = COALESCE($11::timestamptz, completed_at),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.status ?? null,
        patch.remoteTaskId ?? null,
        patch.attempt ?? null,
        patch.correlation !== undefined,
        patch.correlation !== undefined ? jsonParam(toJson(patch.correlation)) : null,
        patch.result !== undefined,
        patch.result !== undefined ? jsonParam(patch.result) : null,
        patch.error !== undefined,
        patch.error !== undefined ? jsonParam(patch.error) : null,
        patch.completedAt ?? null,
      ],
    );
    return mapRemoteOperation(result.rows[0]!);
  }

  async findRemoteOperationByClientRequest(clientRequestId: string): Promise<RemoteOperation | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM remote_operations WHERE client_request_id = $1 ORDER BY created_at LIMIT 1",
      [clientRequestId],
    );
    return result.rows[0] ? mapRemoteOperation(result.rows[0]) : null;
  }

  async getRemoteOperationByRemoteTask(provider: string, remoteTaskId: string): Promise<RemoteOperation | null> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM remote_operations WHERE provider = $1 AND remote_task_id = $2 LIMIT 1",
      [provider, remoteTaskId],
    );
    return result.rows[0] ? mapRemoteOperation(result.rows[0]) : null;
  }

  async updateToolCall(
    id: string,
    patch: { status?: StepStatus; attempt?: number },
  ): Promise<ToolCallRecord> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE tool_calls SET
         status = COALESCE($2, status),
         attempt = COALESCE($3, attempt)
       WHERE id = $1
       RETURNING *`,
      [id, patch.status ?? null, patch.attempt ?? null],
    );
    return mapToolCall(result.rows[0]!);
  }

  async completeToolCall(id: string, patch: {
    status: StepStatus;
    result?: Json | null;
    error?: PersistedError | null;
    attempt?: number;
  }): Promise<ToolCallRecord> {
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE tool_calls SET
         status = $2,
         result = $3::jsonb,
         error = $4::jsonb,
         attempt = COALESCE($5, attempt),
         completed_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.status,
        jsonParam(patch.result ?? null),
        patch.error ? jsonParam(patch.error) : null,
        patch.attempt ?? null,
      ],
    );
    return mapToolCall(result.rows[0]!);
  }
}

function mapAgentRun(row: Record<string, unknown>): AgentRunRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stepRunId: String(row.step_run_id),
    agentName: String(row.agent_name),
    status: String(row.status) as AgentRunStatus,
    currentTurn: Number(row.current_turn),
    toolCallCount: Number(row.tool_call_count),
    modelCallCount: Number(row.model_call_count),
    limits: (parseJson(row.limits) as AgentLimits | null) ?? {},
    output: row.output === null || row.output === undefined ? null : parseJson(row.output),
    error: row.error ? (parseJson(row.error) as unknown as PersistedError) : null,
    parentAgentRunId: row.parent_agent_run_id ? String(row.parent_agent_run_id) : null,
    parentExecutionId: row.parent_execution_id ? String(row.parent_execution_id) : String(row.run_id),
    rootExecutionId: row.root_execution_id ? String(row.root_execution_id) : String(row.run_id),
    depth: row.depth === null || row.depth === undefined ? 0 : Number(row.depth),
    failurePolicy: row.failure_policy === "return-error" ? "return-error" : "fail-parent",
    cancellationPolicy: row.cancellation_policy === "detach" ? "detach" : "propagate",
    startedAt: requiredIso(row.started_at as Date | string),
    completedAt: toIso(row.completed_at as Date | string | null),
  };
}

function mapAgentTurn(row: Record<string, unknown>): AgentTurnRecord {
  return {
    id: String(row.id),
    agentRunId: String(row.agent_run_id),
    runId: String(row.run_id),
    turnNumber: Number(row.turn_number),
    inputMessages: row.input_messages === null || row.input_messages === undefined ? null : parseJson(row.input_messages),
    outputMessages: row.output_messages === null || row.output_messages === undefined ? null : parseJson(row.output_messages),
    requestedTools: row.requested_tools === null || row.requested_tools === undefined ? null : parseJson(row.requested_tools),
    startedAt: requiredIso(row.started_at as Date | string),
    completedAt: toIso(row.completed_at as Date | string | null),
    error: row.error ? (parseJson(row.error) as unknown as PersistedError) : null,
  };
}

function mapModelCall(row: Record<string, unknown>): ModelCallRecord {
  return {
    id: String(row.id),
    agentRunId: String(row.agent_run_id),
    agentTurnId: String(row.agent_turn_id),
    runId: String(row.run_id),
    provider: String(row.provider),
    model: row.model ? String(row.model) : null,
    request: row.request === null || row.request === undefined ? null : parseJson(row.request),
    response: row.response === null || row.response === undefined ? null : parseJson(row.response),
    tokenInput: row.token_input === null || row.token_input === undefined ? null : Number(row.token_input),
    tokenOutput: row.token_output === null || row.token_output === undefined ? null : Number(row.token_output),
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    stopReason: row.stop_reason ? String(row.stop_reason) : null,
    attempt: Number(row.attempt),
    error: row.error ? (parseJson(row.error) as unknown as PersistedError) : null,
    startedAt: requiredIso(row.started_at as Date | string),
    completedAt: toIso(row.completed_at as Date | string | null),
  };
}

function mapToolCall(row: Record<string, unknown>): ToolCallRecord {
  return {
    id: String(row.id),
    agentRunId: String(row.agent_run_id),
    agentTurnId: row.agent_turn_id ? String(row.agent_turn_id) : null,
    runId: String(row.run_id),
    name: String(row.name),
    source: (row.source ? String(row.source) : "local") as ToolSource,
    server: row.server ? String(row.server) : null,
    arguments: row.arguments === null || row.arguments === undefined ? null : parseJson(row.arguments),
    result: row.result === null || row.result === undefined ? null : parseJson(row.result),
    status: String(row.status) as StepStatus,
    attempt: Number(row.attempt),
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    error: row.error ? (parseJson(row.error) as unknown as PersistedError) : null,
    startedAt: requiredIso(row.started_at as Date | string),
    completedAt: toIso(row.completed_at as Date | string | null),
  };
}

function mapInteraction(row: Record<string, unknown>): HumanInteraction {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stepRunId: String(row.step_run_id),
    interactionId: String(row.interaction_id),
    type: String(row.type),
    title: String(row.title),
    description: row.description ? String(row.description) : null,
    status: String(row.status) as HumanInteractionStatus,
    decision: row.decision ? (parseJson(row.decision) as HumanDecision) : null,
    metadata: row.metadata === null || row.metadata === undefined ? null : parseJson(row.metadata),
    createdAt: requiredIso(row.created_at as Date | string),
    completedAt: toIso(row.completed_at as Date | string | null),
  };
}

function mapRemoteOperation(row: Record<string, unknown>): RemoteOperation {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stepRunId: row.step_run_id ? String(row.step_run_id) : null,
    capabilityId: String(row.capability_id),
    provider: String(row.provider),
    endpointRef: String(row.endpoint_ref),
    remoteTaskId: row.remote_task_id ? String(row.remote_task_id) : null,
    clientRequestId: String(row.client_request_id),
    status: String(row.status) as RemoteOperationStatus,
    attempt: Number(row.attempt),
    protocolVersion: String(row.protocol_version),
    correlation: parseJson(row.correlation),
    result: row.result === null || row.result === undefined ? null : parseJson(row.result),
    error: row.error ? (parseJson(row.error) as unknown as PersistedError) : null,
    createdAt: requiredIso(row.created_at as Date | string),
    updatedAt: requiredIso(row.updated_at as Date | string),
    completedAt: toIso(row.completed_at as Date | string | null),
  };
}
