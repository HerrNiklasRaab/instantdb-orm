import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Migrations } from "./Migrations";

const USER = "postgres";
const PASSWORD = "postgres";

/**
 * A real Postgres server, started from binaries for this machine, for tests
 * whose database is shared by more than one process: each connection gets its
 * own session, as in production. Its data lives in a fresh temporary
 * directory and is deleted on close.
 */
export class PostgresServer {
  private constructor(
    private readonly cluster: EmbeddedPostgres,
    readonly url: string,
  ) {}

  static async start(migrationsDir: string): Promise<PostgresServer> {
    const port = await PostgresServer.freePort();
    const cluster = new EmbeddedPostgres({
      databaseDir: mkdtempSync(join(tmpdir(), "upfor-postgres-")),
      port,
      user: USER,
      password: PASSWORD,
      persistent: false,
      postgresFlags: ["-c", "wal_level=logical"],
      onLog: () => undefined,
    });
    await cluster.initialise();
    await cluster.start();
    const server = new PostgresServer(cluster, `postgres://${USER}:${PASSWORD}@127.0.0.1:${String(port)}/postgres`);
    try {
      await server.migrate(migrationsDir);
    } catch (error) {
      await server.close();
      throw error;
    }
    return server;
  }

  close(): Promise<void> {
    return this.cluster.stop();
  }

  private async migrate(migrationsDir: string): Promise<void> {
    const client = this.cluster.getPgClient();
    await client.connect();
    try {
      for (const sql of new Migrations(migrationsDir).scripts()) await client.query(sql);
    } finally {
      await client.end();
    }
  }

  private static freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        probe.close(() => {
          if (address !== null && typeof address === "object") resolve(address.port);
          else reject(new Error("PostgresServer: no port assigned"));
        });
      });
    });
  }
}
