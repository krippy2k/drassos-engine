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

export const MIGRATIONS: Array<{ id: string; statements: string[] }> = [
  { id: MIGRATION_ID, statements: MIGRATION_STATEMENTS },
  { id: "002_agentic", statements: MIGRATION_002_STATEMENTS },
];
