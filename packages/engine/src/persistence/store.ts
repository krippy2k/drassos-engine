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
  Json,
  ModelCallRecord,
  PersistedError,
  StepRun,
  StepStatus,
  StepType,
  ToolCallRecord,
  ToolInvocation,
  ToolSource,
  WorkItem,
  WorkItemType,
  WorkflowRun,
  WorkflowStatus,
} from "../core/types.ts";
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
  return {
    id: String(row.id),
    runId: String(row.run_id),
    type: String(row.type) as WorkItemType,
    payload: parseJson(row.payload),
    availableAt: requiredIso(row.available_at as Date | string),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseExpiresAt: toIso(row.lease_expires_at as Date | string | null),
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
  }): Promise<WorkflowRun> {
    const id = input.id ?? randomUUID();
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO workflow_runs (
         id, workflow_name, workflow_version, input, status,
         parent_run_id, parent_step_id, child_depth, cancel_on_parent_cancel
       )
       VALUES ($1, $2, $3, $4::jsonb, 'PENDING', $5, $6, $7, $8)
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
    const limit = opts?.limit ?? 50;
    if (opts?.workflow) {
      const result = await this.db.query<Record<string, unknown>>(
        `SELECT * FROM workflow_runs WHERE workflow_name = $1 ORDER BY created_at DESC LIMIT $2`,
        [opts.workflow, limit],
      );
      return result.rows.map(mapRun);
    }
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapRun);
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

  async listHistory(runId: string): Promise<HistoryEvent[]> {
    const result = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM history_events WHERE run_id = $1 ORDER BY seq ASC",
      [runId],
    );
    return result.rows.map(mapHistory);
  }

  async enqueueWork(item: {
    id?: string;
    runId: string;
    type: WorkItemType;
    payload?: Json;
    availableAt?: Date | string;
  }): Promise<WorkItem> {
    const id = item.id ?? randomUUID();
    const availableAt =
      item.availableAt instanceof Date
        ? item.availableAt.toISOString()
        : item.availableAt ?? new Date().toISOString();
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO work_items (id, run_id, type, payload, available_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
       RETURNING *`,
      [id, item.runId, item.type, jsonParam(item.payload ?? {}), availableAt],
    );
    return mapWork(result.rows[0]!);
  }

  async claimWork(workerId: string, opts: { limit: number; leaseMs: number }): Promise<WorkItem[]> {
    const leaseExpires = new Date(Date.now() + opts.leaseMs).toISOString();
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE work_items
       SET lease_owner = $1, lease_expires_at = $2::timestamptz
       WHERE id IN (
         SELECT id FROM work_items
         WHERE completed_at IS NULL
           AND available_at <= now()
           AND (lease_expires_at IS NULL OR lease_expires_at < now())
         ORDER BY available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $3
       )
       RETURNING *`,
      [workerId, leaseExpires, opts.limit],
    );
    return result.rows.map(mapWork);
  }

  async heartbeatWork(id: string, workerId: string, leaseMs: number): Promise<boolean> {
    const leaseExpires = new Date(Date.now() + leaseMs).toISOString();
    const result = await this.db.query<Record<string, unknown>>(
      `UPDATE work_items
       SET lease_expires_at = $3::timestamptz
       WHERE id = $1 AND lease_owner = $2 AND completed_at IS NULL
       RETURNING id`,
      [id, workerId, leaseExpires],
    );
    return result.rows.length > 0;
  }

  async completeWork(id: string): Promise<void> {
    await this.db.query(
      "UPDATE work_items SET completed_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE id = $1",
      [id],
    );
  }

  async expireWorkLease(id: string): Promise<void> {
    await this.db.query(
      "UPDATE work_items SET lease_owner = NULL, lease_expires_at = now() - interval '1 second' WHERE id = $1 AND completed_at IS NULL",
      [id],
    );
  }

  async upsertWorker(id: string, metadata: Json = {}): Promise<void> {
    await this.db.query(
      `INSERT INTO workers (id, last_heartbeat, metadata)
       VALUES ($1, now(), $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET last_heartbeat = now(), metadata = EXCLUDED.metadata`,
      [id, jsonParam(metadata)],
    );
  }

  async heartbeatWorker(id: string): Promise<void> {
    await this.db.query("UPDATE workers SET last_heartbeat = now() WHERE id = $1", [id]);
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
       ORDER BY received_at
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

  async cancelPendingHumanTasks(runId: string): Promise<void> {
    await this.db.query(
      `UPDATE human_tasks SET status = 'cancelled' WHERE run_id = $1 AND status = 'pending'`,
      [runId],
    );
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
  }): Promise<AgentRunRecord> {
    const id = run.id ?? randomUUID();
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO agent_runs (id, run_id, step_run_id, agent_name, status, limits)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       RETURNING *`,
      [id, run.runId, run.stepRunId, run.agentName, run.status ?? "RUNNING", jsonParam(run.limits ?? {})],
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
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'RUNNING',$9,$10)
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

  async cancelOpenAgentRuns(runId: string): Promise<void> {
    await this.db.query(
      `UPDATE agent_runs
       SET status = 'CANCELLED', completed_at = now()
       WHERE run_id = $1
         AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')`,
      [runId],
    );
  }

  async listWaitingParentsWithTerminalChildren(): Promise<WorkflowRun[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT p.*
       FROM workflow_runs p
       JOIN workflow_runs c ON p.wait_ref = c.id
       WHERE p.status = 'WAITING'
         AND p.wait_type = 'child'
         AND c.status IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
    );
    return result.rows.map(mapRun);
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
