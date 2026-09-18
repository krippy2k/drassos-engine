export const MIGRATION_ID = "001_initial";

export const MIGRATION_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_definitions (
    name TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    workflow_name TEXT NOT NULL,
    workflow_version TEXT NOT NULL,
    input JSONB NOT NULL DEFAULT 'null'::jsonb,
    output JSONB,
    status TEXT NOT NULL,
    error JSONB,
    cancellation JSONB,
    wait_type TEXT,
    wait_ref TEXT,
    execution_owner TEXT,
    execution_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS workflow_runs_status_idx ON workflow_runs (status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS workflow_runs_name_idx ON workflow_runs (workflow_name, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS step_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    occurrence INTEGER NOT NULL,
    type TEXT NOT NULL,
    input JSONB,
    output JSONB,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 1,
    error JSONB,
    timeout_ms INTEGER,
    idempotency_key TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    UNIQUE (run_id, name, occurrence)
  )`,
  `CREATE INDEX IF NOT EXISTS step_runs_run_id_idx ON step_runs (run_id)`,
  `CREATE TABLE IF NOT EXISTS agent_executions (
    id TEXT PRIMARY KEY,
    step_run_id TEXT NOT NULL REFERENCES step_runs(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT,
    messages JSONB,
    token_input INTEGER,
    token_output INTEGER,
    duration_ms INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS agent_executions_step_idx ON agent_executions (step_run_id)`,
  `CREATE TABLE IF NOT EXISTS tool_invocations (
    id TEXT PRIMARY KEY,
    step_run_id TEXT NOT NULL REFERENCES step_runs(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    input JSONB NOT NULL,
    output JSONB,
    error JSONB,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS tool_invocations_step_idx ON tool_invocations (step_run_id)`,
  `CREATE TABLE IF NOT EXISTS human_tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    step_run_id TEXT NOT NULL REFERENCES step_runs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    occurrence INTEGER NOT NULL,
    title TEXT NOT NULL,
    assigned_to TEXT,
    data JSONB NOT NULL DEFAULT 'null'::jsonb,
    response JSONB,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS human_tasks_status_idx ON human_tasks (status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS timers (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    step_run_id TEXT NOT NULL REFERENCES step_runs(id) ON DELETE CASCADE,
    fire_at TIMESTAMPTZ NOT NULL,
    fired_at TIMESTAMPTZ,
    status TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS timers_due_idx ON timers (status, fire_at)`,
  `CREATE TABLE IF NOT EXISTS external_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    data JSONB NOT NULL DEFAULT 'null'::jsonb,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at TIMESTAMPTZ,
    consumed_by_step_id TEXT,
    delivery_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS external_events_run_type_idx ON external_events (run_id, type, consumed_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS external_events_delivery_idx
     ON external_events (run_id, delivery_id)
     WHERE delivery_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS history_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (run_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS history_events_run_idx ON history_events (run_id, seq)`,
  `CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS work_items_claim_idx
     ON work_items (available_at)
     WHERE completed_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
  )`,
];

export const MIGRATION_002_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS workflow_versions (
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    source_hash TEXT,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (name, version)
  )`,
  `ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS parent_run_id TEXT`,
  `ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS parent_step_id TEXT`,
  `ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS child_depth INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS cancel_on_parent_cancel BOOLEAN NOT NULL DEFAULT TRUE`,
  `CREATE INDEX IF NOT EXISTS workflow_runs_parent_idx ON workflow_runs (parent_run_id)`,
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    step_run_id TEXT NOT NULL REFERENCES step_runs(id) ON DELETE CASCADE,
    agent_name TEXT NOT NULL,
    status TEXT NOT NULL,
    current_turn INTEGER NOT NULL DEFAULT 0,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    model_call_count INTEGER NOT NULL DEFAULT 0,
    limits JSONB NOT NULL DEFAULT '{}'::jsonb,
    output JSONB,
    error JSONB,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS agent_runs_run_idx ON agent_runs (run_id)`,
  `CREATE INDEX IF NOT EXISTS agent_runs_step_idx ON agent_runs (step_run_id)`,
  `CREATE TABLE IF NOT EXISTS agent_turns (
    id TEXT PRIMARY KEY,
    agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    turn_number INTEGER NOT NULL,
    input_messages JSONB,
    output_messages JSONB,
    requested_tools JSONB,
    error JSONB,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    UNIQUE (agent_run_id, turn_number)
  )`,
  `CREATE INDEX IF NOT EXISTS agent_turns_agent_idx ON agent_turns (agent_run_id, turn_number)`,
  `CREATE TABLE IF NOT EXISTS model_calls (
    id TEXT PRIMARY KEY,
    agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    agent_turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT,
    request JSONB,
    response JSONB,
    token_input INTEGER,
    token_output INTEGER,
    latency_ms INTEGER,
    stop_reason TEXT,
    attempt INTEGER NOT NULL DEFAULT 1,
    error JSONB,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS model_calls_agent_idx ON model_calls (agent_run_id)`,
  `CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    agent_turn_id TEXT REFERENCES agent_turns(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'local',
    server TEXT,
    arguments JSONB,
    result JSONB,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    idempotency_key TEXT,
    error JSONB,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS tool_calls_agent_idx ON tool_calls (agent_run_id)`,
];

export const MIGRATION_003_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS human_interactions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    step_run_id TEXT NOT NULL REFERENCES step_runs(id) ON DELETE CASCADE,
    interaction_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'approval',
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL,
    decision JSONB,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS human_interactions_run_idx ON human_interactions (run_id, interaction_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS human_interactions_status_idx ON human_interactions (status, created_at DESC)`,
];

export const MIGRATION_004_STATEMENTS: string[] = [
  `ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS root_run_id TEXT`,
  `ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS failure_policy TEXT NOT NULL DEFAULT 'fail-parent'`,
  `ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS cancellation_policy TEXT NOT NULL DEFAULT 'propagate'`,
  `ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS timeout_at TIMESTAMPTZ`,
  `UPDATE workflow_runs SET root_run_id = id WHERE root_run_id IS NULL`,
  `CREATE INDEX IF NOT EXISTS workflow_runs_root_idx ON workflow_runs (root_run_id)`,
  `CREATE INDEX IF NOT EXISTS workflow_runs_timeout_idx ON workflow_runs (timeout_at) WHERE timeout_at IS NOT NULL`,
  `ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS parent_agent_run_id TEXT`,
  `ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS parent_execution_id TEXT`,
  `ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS root_execution_id TEXT`,
  `ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS depth INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS failure_policy TEXT NOT NULL DEFAULT 'fail-parent'`,
  `ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cancellation_policy TEXT NOT NULL DEFAULT 'propagate'`,
  `UPDATE agent_runs SET root_execution_id = run_id WHERE root_execution_id IS NULL`,
  `UPDATE agent_runs SET parent_execution_id = run_id WHERE parent_execution_id IS NULL`,
  `CREATE INDEX IF NOT EXISTS agent_runs_parent_agent_idx ON agent_runs (parent_agent_run_id)`,
  `CREATE INDEX IF NOT EXISTS agent_runs_parent_execution_idx ON agent_runs (parent_execution_id)`,
  `CREATE INDEX IF NOT EXISTS agent_runs_root_idx ON agent_runs (root_execution_id)`,
];

export const MIGRATION_005_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS remote_operations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    step_run_id TEXT REFERENCES step_runs(id) ON DELETE SET NULL,
    capability_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    endpoint_ref TEXT NOT NULL,
    remote_task_id TEXT,
    client_request_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    protocol_version TEXT NOT NULL DEFAULT '1',
    correlation JSONB NOT NULL DEFAULT '{}'::jsonb,
    result JSONB,
    error JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS remote_operations_request_idx ON remote_operations (run_id, client_request_id)`,
  `CREATE INDEX IF NOT EXISTS remote_operations_run_idx ON remote_operations (run_id, status)`,
  `CREATE INDEX IF NOT EXISTS remote_operations_remote_idx ON remote_operations (provider, remote_task_id)`,
];

export const MIGRATION_006_STATEMENTS: string[] = [
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS queue TEXT NOT NULL DEFAULT 'default'`,
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS name TEXT`,
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS idempotency_key TEXT`,
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS lease_token TEXT`,
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS result JSONB`,
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS error JSONB`,
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS progress JSONB`,
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`,
  `UPDATE work_items SET status = 'completed' WHERE completed_at IS NOT NULL AND status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS work_items_queue_claim_idx
     ON work_items (queue, priority DESC, available_at)
     WHERE completed_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS work_items_idempotency_idx
     ON work_items (run_id, idempotency_key)
     WHERE idempotency_key IS NOT NULL`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS queues TEXT[] NOT NULL DEFAULT ARRAY['default']::TEXT[]`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS capabilities TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS concurrency INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'online'`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS version TEXT`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS protocol_version TEXT NOT NULL DEFAULT '1'`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS hostname TEXT`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS process_id INTEGER`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS available_slots INTEGER`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS active_tasks INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS queue_metrics (
    queue TEXT PRIMARY KEY,
    completed BIGINT NOT NULL DEFAULT 0,
    failed BIGINT NOT NULL DEFAULT 0,
    retries BIGINT NOT NULL DEFAULT 0,
    lease_expirations BIGINT NOT NULL DEFAULT 0
  )`,
];

export const MIGRATION_007_STATEMENTS: string[] = [
  `ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS forked_from_run_id TEXT`,
  `ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS forked_from_seq INTEGER`,
  `CREATE INDEX IF NOT EXISTS workflow_runs_fork_idx ON workflow_runs (forked_from_run_id)`,
];

export const MIGRATION_008_STATEMENTS: string[] = [
  `ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS history_format_version INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS workflow_versions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`,
  `CREATE TABLE IF NOT EXISTS deterministic_values (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    occurrence INTEGER NOT NULL,
    value JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, kind, occurrence)
  )`,
  `CREATE INDEX IF NOT EXISTS deterministic_values_run_idx ON deterministic_values (run_id, kind, occurrence)`,
  `CREATE TABLE IF NOT EXISTS replay_records (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    recorded_version TEXT NOT NULL,
    tested_version TEXT NOT NULL,
    status TEXT NOT NULL,
    events_replayed INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    divergences JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS replay_records_run_idx ON replay_records (run_id, created_at DESC)`,
];

export const MIGRATIONS: Array<{ id: string; statements: string[] }> = [
  { id: MIGRATION_ID, statements: MIGRATION_STATEMENTS },
  { id: "002_agentic", statements: MIGRATION_002_STATEMENTS },
  { id: "003_signals", statements: MIGRATION_003_STATEMENTS },
  { id: "004_orchestration", statements: MIGRATION_004_STATEMENTS },
  { id: "005_interop", statements: MIGRATION_005_STATEMENTS },
  { id: "006_distributed_workers", statements: MIGRATION_006_STATEMENTS },
  { id: "007_observability", statements: MIGRATION_007_STATEMENTS },
  { id: "008_workflow_evolution", statements: MIGRATION_008_STATEMENTS },
];
