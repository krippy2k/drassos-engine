import { MIGRATIONS, MIGRATION_STATEMENTS } from "./schema.ts";
import type { DbClient } from "./client.ts";

export async function migrate(client: DbClient): Promise<void> {
  await client.query(MIGRATION_STATEMENTS[0]!);
  for (const migration of MIGRATIONS) {
    const applied = await client.query<{ id: string }>(
      "SELECT id FROM schema_migrations WHERE id = $1",
      [migration.id],
    );
    if (applied.rows.length > 0) {
      continue;
    }
    await client.transaction(async (tx) => {
      const statements =
        migration.id === "001_initial" ? migration.statements.slice(1) : migration.statements;
      for (const statement of statements) {
        await tx.query(statement);
      }
      await tx.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
    });
  }
}
