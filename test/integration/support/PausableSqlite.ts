import type { ClientOptions } from "@zenstackhq/orm";
import type { SchemaDef } from "@zenstackhq/schema";
import { inMemorySqliteDialect } from "@upfor/sync/test";

type Dialect = ClientOptions<SchemaDef>["dialect"];
type Driver = ReturnType<Dialect["createDriver"]>;
type Connection = Awaited<ReturnType<Driver["acquireConnection"]>>;

// Methods called through the proxy still run on the real object.
function forwarded(target: object, property: string | symbol): unknown {
  const value: unknown = Reflect.get(target, property);
  if (typeof value !== "function") return value;
  return (...args: unknown[]): unknown => {
    const result: unknown = Reflect.apply(value, target, args);
    return result;
  };
}

class Signal {
  readonly reached: Promise<void>;
  private fire!: () => void;

  constructor() {
    this.reached = new Promise((resolve) => { this.fire = resolve; });
  }

  raise(): void {
    this.fire();
  }
}

/**
 * A device's SQLite that the test can stop between two statements, with the
 * database idle, while the device is in the middle of writing a table: what
 * a device's own reads find at that moment is what the engine lets them see.
 */
export class PausableSqlite {
  readonly dialect: Dialect;
  private table: string | null = null;
  private wroteTable = false;
  private paused: Signal | null = null;
  private resumed: Signal | null = null;

  constructor() {
    const dialect = inMemorySqliteDialect();
    this.dialect = new Proxy(dialect, {
      get: (target, property) => property === "createDriver" ? () => this.driver(target.createDriver()) : forwarded(target, property),
    });
  }

  /** Resolves once the device has written its first row of `table` and let go of the database. */
  pauseAfterFirstWriteTo(table: string): Promise<void> {
    this.table = table;
    this.wroteTable = false;
    this.paused = new Signal();
    this.resumed = new Signal();
    return this.paused.reached;
  }

  resume(): void {
    this.resumed?.raise();
    this.resumed = null;
  }

  private driver(driver: Driver): Driver {
    return new Proxy(driver, {
      get: (target, property) => {
        if (property === "acquireConnection") return async () => this.connection(await target.acquireConnection());
        if (property === "releaseConnection") {
          return async (connection: Connection) => {
            await target.releaseConnection(connection);
            await this.holdIfDue();
          };
        }
        return forwarded(target, property);
      },
    });
  }

  private connection(connection: Connection): Connection {
    return new Proxy(connection, {
      get: (target, property) => {
        if (property !== "executeQuery") return forwarded(target, property);
        return async (...args: Parameters<Connection["executeQuery"]>) => {
          const [query] = args;
          if (this.table !== null && query.sql.startsWith(`insert into "${this.table}"`)) this.wroteTable = true;
          return target.executeQuery(...args);
        };
      },
    });
  }

  private async holdIfDue(): Promise<void> {
    if (!this.wroteTable || !this.paused || !this.resumed) return;
    const resumed = this.resumed;
    this.paused.raise();
    this.table = null;
    this.wroteTable = false;
    this.paused = null;
    await resumed.reached;
  }
}
