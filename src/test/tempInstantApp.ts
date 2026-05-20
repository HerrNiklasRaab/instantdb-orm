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

export interface TempInstantApp {
  appId: string;
  adminToken: string;
}

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

/**
 * Mint a fresh sandbox InstantDB app via the platform SDK's
 * `createTemporaryApp`. The app self-deletes after ~2 weeks and is anonymous
 * (won't appear in any dashboard). No auth needed — the underlying
 * `/dash/apps/ephemeral` endpoint is open. We pass a dummy token only to
 * satisfy the SDK's constructor (the impl doesn't use it for this call).
 */
export async function provisionTempInstantApp(
  titlePrefix: string
): Promise<TempInstantApp> {
  const api = new PlatformApi({ auth: { token: "ephemeral-only" } });
  const { app } = await api.createTemporaryApp({
    title: `${titlePrefix}-${Date.now()}`,
  });
  return { appId: app.id, adminToken: app.adminToken };
}

/**
 * Push a schema via the platform SDK. `overwrite: true` enables destructive
 * changes (drop attrs, etc.) — fine for ephemeral test apps.
 */
export async function pushSchema(
  app: TempInstantApp,
  schema: unknown
): Promise<void> {
  if (!isInstantSchema(schema)) {
    throw new Error("pushSchema: schema is not a valid InstantSchemaDef");
  }
  const api = new PlatformApi({ auth: { token: app.adminToken } });
  await api.schemaPush(app.appId, {
    schema,
    overwrite: true,
  });
}

/**
 * Push perms via the platform SDK. Completely replaces the current rule set.
 */
export async function pushPerms(
  app: TempInstantApp,
  perms: unknown
): Promise<void> {
  if (!isInstantRules(perms)) {
    throw new Error("pushPerms: perms is not a valid InstantRules object");
  }
  const api = new PlatformApi({ auth: { token: app.adminToken } });
  await api.pushPerms(app.appId, { perms });
}

// Stay safely under the temp app's auto-delete; re-provision with margin so
// a run that straddles the cutoff doesn't suddenly find its app gone.
const CACHE_TTL_MS = 12 * 24 * 60 * 60 * 1000; // 12 days (temp app lives ~14)

interface CachedApp extends TempInstantApp {
  schemaHash: string;
  permsHash: string;
  createdAt: string;
}

export interface ProvisionedApp extends TempInstantApp {
  /** True if we returned a cached app instead of minting a new one. Callers
   *  use this to decide whether to wipe stale data. */
  reused: boolean;
}

export interface AppCacheRequest {
  /** Local file path used to persist app creds + schema/perms hashes
   *  between runs. Live in node_modules/.cache so it's gitignored. */
  cacheFile: string;
  titlePrefix: string;
  schemaPath: string;
  permsPath: string;
  schema: unknown;
  perms: unknown;
}

/**
 * Try to reuse a cached temp app from a prior run. Re-provisions iff:
 *   - no cache file, OR
 *   - schema/perms files have changed (hash mismatch), OR
 *   - the cached app is older than ~12 days (close to temp-app expiry).
 *
 * Reuse cuts provision+push off subsequent runs locally.
 */
export async function getOrProvisionApp(
  req: AppCacheRequest
): Promise<ProvisionedApp> {
  const schemaHash = hashFile(req.schemaPath);
  const permsHash = hashFile(req.permsPath);
  const cached = readCache(req.cacheFile);
  const ageOk =
    cached && Date.now() - new Date(cached.createdAt).getTime() < CACHE_TTL_MS;

  if (cached && ageOk && cached.schemaHash === schemaHash && cached.permsHash === permsHash) {
    console.log(`Reusing cached test app: ${cached.appId}`);
    return { appId: cached.appId, adminToken: cached.adminToken, reused: true };
  }

  const app = await provisionTempInstantApp(req.titlePrefix);
  console.log(`Provisioned temp test app: ${app.appId}`);
  await pushSchema(app, req.schema);
  await pushPerms(app, req.perms);
  writeCache(req.cacheFile, {
    ...app,
    schemaHash,
    permsHash,
    createdAt: new Date().toISOString(),
  });
  return { ...app, reused: false };
}

/**
 * Delete every row from every entity in the schema. Called on cache hit so
 * each run starts from a clean DB without re-pushing the schema.
 *
 * The table list is derived from `schema.entities` so adding a new model
 * doesn't require updating a hardcoded list. System entities (prefixed
 * with `$`, e.g. `$users`, `$files`) are skipped — those are auth/storage
 * managed by InstantDB and shouldn't be touched. Pass `exclude` to keep
 * additional tables intact.
 */
export async function wipeAppData(opts: {
  app: TempInstantApp;
  schema: unknown;
  exclude?: readonly string[];
}): Promise<void> {
  if (!isInstantSchema(opts.schema)) {
    throw new Error("wipeAppData: schema is not a valid InstantSchemaDef");
  }
  const schema = opts.schema;
  const tables = entityNames(schema, opts.exclude ?? []);
  if (tables.length === 0) return;

  const db = init({
    appId: opts.app.appId,
    adminToken: opts.app.adminToken,
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
      chunks.push(tx[table][rowId].delete());
    }
  }
  if (chunks.length > 0) {
    await db.transact(chunks);
    console.log(`Wiped ${chunks.length} rows from cached test app`);
  }
}

function entityNames(schema: InstantUnknownSchema, exclude: readonly string[]): string[] {
  const entities = schema.entities;
  const skip = new Set(exclude);
  return Object.keys(entities).filter(
    // System entities ($users, $files, …) are managed by InstantDB itself.
    (name) => !name.startsWith("$") && !skip.has(name)
  );
}

function hashFile(path: string): string {
  return createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

function readCache(path: string): CachedApp | null {
  if (!fs.existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
    return isCachedApp(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(path: string, app: CachedApp): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(app), "utf8");
}
