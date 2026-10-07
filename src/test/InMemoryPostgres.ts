import { PGlite } from "@electric-sql/pglite";
import { ZenStackClient } from "@zenstackhq/orm";
import { PolicyPlugin } from "@zenstackhq/plugin-policy";
import type { SchemaDef } from "@zenstackhq/schema";
import { PGliteDialect } from "kysely-pglite-dialect";
import { SyncServer, type SyncIdentity } from "../server";
import { Migrations } from "./Migrations";

/**
 * Postgres compiled to WASM, running in this process. The schema comes from
 * the same migration SQL a real deployment applies, so what tests run
 * against is the production DDL, not an approximation of it.
 */
export class InMemoryPostgres {
  private constructor(private readonly pg: PGlite) {}

  static async start(migrationsDir: string): Promise<InMemoryPostgres> {
    const pg = new PGlite();
    for (const sql of new Migrations(migrationsDir).scripts()) {
      await pg.exec(sql);
    }
    return new InMemoryPostgres(pg);
  }

  /** A started sync server on this database; close the previous one first, since one feed reads the WAL. */
  async server<Schema extends SchemaDef>(schema: Schema): Promise<SyncServer<Schema>> {
    const definition: SchemaDef = schema;
    const unrestricted = new ZenStackClient(definition, { dialect: new PGliteDialect(this.pg) });
    const policed = unrestricted.$use(new PolicyPlugin());
    const server = new SyncServer(schema, {
      unrestricted,
      forIdentity: (identity: SyncIdentity | null) => policed.$setAuth(identity ? { id: identity.id } : undefined),
    });
    await server.start();
    return server;
  }

  /** Runs SQL straight against the database, the way a writer that knows nothing of the sync server would. */
  async execute(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async select(sql: string): Promise<unknown[]> {
    return (await this.pg.query(sql)).rows;
  }

  /** Empties every table so the next test starts from the migrated schema alone. */
  async clear(): Promise<void> {
    const tables = (await this.pg.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    )).rows.map((row) => `"${row.tablename}"`);
    if (tables.length > 0) await this.pg.exec(`TRUNCATE ${tables.join(", ")} CASCADE`);
  }

  close(): Promise<void> {
    return this.pg.close();
  }
}
