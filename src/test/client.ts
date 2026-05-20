import { init, id } from "@instantdb/admin";
import type {
  InstaQLResponse,
  TransactionChunk,
  TxChunk,
  ValidQuery,
} from "@instantdb/core";
import {
  InstantDBClient,
  type AnySchema,
  type QuerySubscriptionState,
  type Unsubscribe,
} from "../instantdb";
import { InstantDBAdminAdapter } from "../admin/InstantDBAdminAdapter";

export { id };

type AdminDB<Schema extends AnySchema> = ReturnType<typeof init<Schema>>;

export class TestInstantDBClient<Schema extends AnySchema>
  extends InstantDBClient<Schema>
{
  readonly __adminDb: AdminDB<Schema>;
  private readonly inner: InstantDBAdminAdapter<Schema>;
  readonly tx: TxChunk<Schema>;

  constructor(adminDb: AdminDB<Schema>, forwarded: AdminDB<Schema>) {
    super();
    this.__adminDb = adminDb;
    this.inner = new InstantDBAdminAdapter<Schema>(forwarded);
    this.tx = this.inner.tx;
  }

  query<Q extends ValidQuery<Q, Schema>>(
    queryObj: Q,
  ): Promise<InstaQLResponse<Schema, Q>> {
    return this.inner.query<Q>(queryObj);
  }

  transact(
    chunks: TransactionChunk<Schema, keyof Schema["entities"] & string>[],
  ): Promise<void> {
    return this.inner.transact(chunks);
  }

  subscribeQuery<Q extends ValidQuery<Q, Schema>>(
    queryObj: Q,
    callback: (state: QuerySubscriptionState<Schema, Q>) => void,
  ): Unsubscribe {
    return this.inner.subscribeQuery<Q>(queryObj, callback);
  }
}

/**
 * Reads `INSTANTDB_APP_ID` / `INSTANTDB_ADMIN_TOKEN` from env. globalSetup
 * provisions the temp app, the per-worker setup file plants the creds in
 * env. Schema is needed at init time so the admin SDK can validate queries
 * against it.
 */
export function getAdminDb<Schema extends AnySchema>(schema: Schema): AdminDB<Schema> {
  const appId = process.env.INSTANTDB_APP_ID;
  const adminToken = process.env.INSTANTDB_ADMIN_TOKEN;
  if (!appId || !adminToken) {
    throw new Error(
      "INSTANTDB_APP_ID / INSTANTDB_ADMIN_TOKEN missing — globalSetup should have planted them."
    );
  }
  return init<Schema>({ appId, adminToken, schema });
}

/** Admin-context client — bypasses permission rules. */
export function initTestDatabase<Schema extends AnySchema>(
  schema: Schema
): TestInstantDBClient<Schema> {
  const db = getAdminDb<Schema>(schema);
  return new TestInstantDBClient<Schema>(db, db);
}

/** User-scoped client — respects permission rules. */
export function initTestDatabaseAsUser<Schema extends AnySchema>(
  schema: Schema,
  email: string
): TestInstantDBClient<Schema> {
  const db = getAdminDb<Schema>(schema);
  return new TestInstantDBClient<Schema>(db, db.asUser({ email }));
}

/** Create (or fetch existing) auth user, return their `$users` id. */
export async function seedAuthUser<Schema extends AnySchema>(
  schema: Schema,
  email: string
): Promise<string> {
  const db = getAdminDb<Schema>(schema);
  await db.auth.createToken({ email });
  const user = await db.auth.getUser({ email });
  if (!user) throw new Error(`seedAuthUser: createToken succeeded but getUser returned null for ${email}`);
  return user.id;
}

export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await wait(intervalMs);
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

export function waitForSubscription<Schema extends AnySchema, Q extends ValidQuery<Q, Schema>, T>(
  client: TestInstantDBClient<Schema>,
  queryObj: Q,
  predicate: (data: unknown) => data is T,
  timeoutMs: number = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Subscription timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const unsubscribe = client.subscribeQuery(queryObj, ({ error, data }) => {
      if (error) {
        clearTimeout(timer);
        unsubscribe();
        reject(new Error(error.message));
        return;
      }
      if (predicate(data)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(data);
      }
    });
  });
}
