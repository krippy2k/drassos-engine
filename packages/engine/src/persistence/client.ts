export interface QueryResult<T> {
  rows: T[];
}

export interface DbClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function normalizeRows<T>(rows: unknown): T[] {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows as T[];
}

export async function createPgClient(connectionString: string): Promise<DbClient> {
  const pg = await import("pg");
  const Pool = pg.default.Pool;
  const pool = new Pool({ connectionString });
  return new NodePgClient(pool);
}

class NodePgClient implements DbClient {
  constructor(
    private readonly pool: import("pg").Pool,
    private readonly client?: import("pg").PoolClient,
  ) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const target = this.client ?? this.pool;
    const result = await target.query(sql, params);
    return { rows: normalizeRows<T>(result.rows) };
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    if (this.client) {
      return fn(this);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tx = new NodePgClient(this.pool, client);
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback failures
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (!this.client) {
      await this.pool.end();
    }
  }
}

export async function createPgliteClient(dataDir?: string): Promise<DbClient> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  return new PgliteDbClient(db);
}

class PgliteDbClient implements DbClient {
  constructor(
    private readonly db: import("@electric-sql/pglite").PGlite,
    private readonly inTransaction = false,
  ) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.db.query(sql, params);
    return { rows: normalizeRows<T>(result.rows) };
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      return fn(this);
    }
    return this.db.transaction(async (tx) => {
      const wrapped: DbClient = {
        query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
          const result = await tx.query(sql, params);
          return { rows: normalizeRows<R>(result.rows) };
        },
        transaction: async (inner) => inner(wrapped),
        close: async () => {},
      };
      return fn(wrapped);
    });
  }

  async close(): Promise<void> {
    if (!this.inTransaction) {
      await this.db.close();
    }
  }
}

export async function createDbClient(options: {
  databaseUrl?: string;
  dataDir?: string;
}): Promise<{ client: DbClient; kind: "postgres" | "pglite" }> {
  if (options.databaseUrl) {
    return { client: await createPgClient(options.databaseUrl), kind: "postgres" };
  }
  return { client: await createPgliteClient(options.dataDir), kind: "pglite" };
}
