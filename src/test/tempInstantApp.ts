import * as fs from "fs";
import { dirname } from "path";
import { createHash } from "crypto";
import { init } from "@instantdb/admin";
import type {
  InstantRules,
  InstantUnknownSchema,
  TransactionChunk,
} from "@instantdb/admin";
import { PlatformApi } from "@instantdb/platform";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function isInstantSchema(v: unknown): v is InstantUnknownSchema {
  if (!isPlainObject(v)) return false;
  const entities = Reflect.get(v, "entities");
  return isPlainObject(entities);
}

function isInstantRules(v: unknown): v is InstantRules {
  return isPlainObject(v);
}

export class TempInstantApp {
  private constructor(
    private readonly _appId: string,
    private readonly _adminToken: string,
  ) {}

  get appId(): string {
    return this._appId;
  }

  get adminToken(): string {
    return this._adminToken;
  }

  // No auth needed — the `/dash/apps/ephemeral` endpoint is open; the dummy
  // token only satisfies the SDK constructor. App self-deletes after ~2 weeks.
  static async provision(titlePrefix: string): Promise<TempInstantApp> {
    const api = new PlatformApi({ auth: { token: "ephemeral-only" } });
    const { app } = await api.createTemporaryApp({
      title: `${titlePrefix}-${Date.now()}`,
    });
    return new TempInstantApp(app.id, app.adminToken);
  }

  static fromCredentials(appId: string, adminToken: string): TempInstantApp {
    return new TempInstantApp(appId, adminToken);
  }

  async pushSchema(schema: unknown): Promise<void> {
    if (!isInstantSchema(schema)) {
      throw new Error("TempInstantApp.pushSchema: schema is not a valid InstantSchemaDef");
    }
    await this.platformApi().schemaPush(this._appId, { schema, overwrite: true });
  }

  async pushPerms(perms: unknown): Promise<void> {
    if (!isInstantRules(perms)) {
      throw new Error("TempInstantApp.pushPerms: perms is not a valid InstantRules object");
    }
    await this.platformApi().pushPerms(this._appId, { perms });
  }

  // Wipes every entity including the system `$users`/`$files`: both are
  // auth/storage-managed but still removable via a plain `tx[...].delete()`
  // (InstantDB documents tx-delete as the way to drop files), so no separate
  // `auth.deleteUser`/storage call is needed.
  async wipeData(schema: unknown): Promise<void> {
    if (!isInstantSchema(schema)) {
      throw new Error("TempInstantApp.wipeData: schema is not a valid InstantSchemaDef");
    }
    const tables = Object.keys(schema.entities);
    if (tables.length === 0) return;

    const db = init({
      appId: this._appId,
      adminToken: this._adminToken,
      schema,
    });
    const query: Record<string, Record<string, never>> = Object.fromEntries(
      tables.map((t) => [t, {}])
    );
    const result: unknown = await db.query(query);
    if (!isPlainObject(result)) return;

    const tx: Record<string, Record<string, { delete: () => TransactionChunk<InstantUnknownSchema, string> }>> = db.tx;
    const chunks: TransactionChunk<InstantUnknownSchema, string>[] = [];
    for (const table of tables) {
      const rows = Reflect.get(result, table);
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!isPlainObject(row)) continue;
        const rowId = Reflect.get(row, "id");
        if (typeof rowId !== "string") continue;
        const tableTx = tx[table];
        const rowTx = tableTx?.[rowId];
        if (rowTx) chunks.push(rowTx.delete());
      }
    }
    if (chunks.length > 0) {
      await db.transact(chunks);
      console.log(`Wiped ${chunks.length} rows from cached test app`);
    }
  }

  private platformApi(): PlatformApi {
    return new PlatformApi({ auth: { token: this._adminToken } });
  }
}

interface CachedApp {
  appId: string;
  adminToken: string;
  schemaHash: string;
  permsHash: string;
  createdAt: string;
}

function isCachedApp(v: unknown): v is CachedApp {
  if (!isPlainObject(v)) return false;
  const appId = Reflect.get(v, "appId");
  const adminToken = Reflect.get(v, "adminToken");
  const schemaHash = Reflect.get(v, "schemaHash");
  const permsHash = Reflect.get(v, "permsHash");
  const createdAt = Reflect.get(v, "createdAt");
  return (
    typeof appId === "string" &&
    typeof adminToken === "string" &&
    typeof schemaHash === "string" &&
    typeof permsHash === "string" &&
    typeof createdAt === "string"
  );
}

function hashFile(path: string): string {
  return createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

export class TestAppCache {
  // 12d, safely under the temp app's ~14d auto-delete so a run straddling the
  // cutoff doesn't find its app already gone.
  private static readonly TTL_MS = 12 * 24 * 60 * 60 * 1000;

  constructor(
    private readonly cacheFile: string,
    private readonly schemaPath: string,
    private readonly permsPath: string,
  ) {}

  load(): TempInstantApp | null {
    const entry = this.read();
    if (!entry || !this.isFresh(entry)) return null;
    return TempInstantApp.fromCredentials(entry.appId, entry.adminToken);
  }

  store(app: TempInstantApp): void {
    this.write({
      appId: app.appId,
      adminToken: app.adminToken,
      schemaHash: hashFile(this.schemaPath),
      permsHash: hashFile(this.permsPath),
      createdAt: new Date().toISOString(),
    });
  }

  private isFresh(entry: CachedApp): boolean {
    const ageMs = Date.now() - new Date(entry.createdAt).getTime();
    return (
      ageMs < TestAppCache.TTL_MS &&
      entry.schemaHash === hashFile(this.schemaPath) &&
      entry.permsHash === hashFile(this.permsPath)
    );
  }

  private read(): CachedApp | null {
    if (!fs.existsSync(this.cacheFile)) return null;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
      return isCachedApp(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private write(entry: CachedApp): void {
    fs.mkdirSync(dirname(this.cacheFile), { recursive: true });
    fs.writeFileSync(this.cacheFile, JSON.stringify(entry), "utf8");
  }
}

export interface AppCacheRequest {
  cacheFile: string;
  titlePrefix: string;
  schemaPath: string;
  permsPath: string;
  schema: unknown;
  perms: unknown;
}

export class TestAppProvisioner {
  constructor(
    private readonly cache: TestAppCache,
    private readonly titlePrefix: string,
    private readonly schema: unknown,
    private readonly perms: unknown,
  ) {}

  static fromRequest(req: AppCacheRequest): TestAppProvisioner {
    const cache = new TestAppCache(req.cacheFile, req.schemaPath, req.permsPath);
    return new TestAppProvisioner(cache, req.titlePrefix, req.schema, req.perms);
  }

  async getCleanApp(): Promise<TempInstantApp> {
    const cached = this.cache.load();
    if (cached) {
      console.log(`Reusing cached test app: ${cached.appId}`);
      await cached.wipeData(this.schema);
      return cached;
    }

    const app = await TempInstantApp.provision(this.titlePrefix);
    console.log(`Provisioned temp test app: ${app.appId}`);
    await app.pushSchema(this.schema);
    await app.pushPerms(this.perms);
    this.cache.store(app);
    return app;
  }
}
