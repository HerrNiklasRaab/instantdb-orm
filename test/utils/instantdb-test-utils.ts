import { init, id } from "@instantdb/admin";
import type {
  InstantDBClient,
  TxChunk,
  SubscriptionCallback,
  Unsubscribe,
  TransactionResult,
} from "../../src/object-graph/persistence/types";
import { configureEntityMeta } from "../../src/object-graph";
import schema from "../instant.schema";

// Side-effect imports: @model decorator auto-registers these entities
import "../entities/User";
import "../entities/Profile";
import "../entities/Post";
// STI entities (single table with type discriminator)
import "../entities/ChessInvitation";
import "../entities/SkiInvitation";
// MTI entities (separate tables)
import "../entities/ChessMatch";
import "../entities/SkiMatch";

// Re-export id() for generating UUIDs in tests
export { id };

// Type for admin DB instance
type AdminDB = ReturnType<typeof init>;

// Type for user-scoped DB instance (returned by asUser)
type UserScopedDB = ReturnType<AdminDB["asUser"]>;

// Hardcoded credentials for the dedicated InstantDB *test* app. Tests must
// never hit any other app — teardown deletes every row of every test entity.
export const TEST_INSTANTDB_APP_ID = "51633990-ecae-4480-b1fe-ec9ae671033d";
export const TEST_INSTANTDB_ADMIN_TOKEN = "5e859b49-b627-4960-934f-2c414a4b36f5";

// Admin DB instance (singleton)
let adminDb: AdminDB | null = null;

export interface TestInstantDBClient extends InstantDBClient {
  __adminDb: AdminDB;
}

/**
 * Get or create the singleton admin DB instance.
 */
export function getAdminDb(): AdminDB {
  if (!adminDb) {
    adminDb = init({
      appId: TEST_INSTANTDB_APP_ID,
      adminToken: TEST_INSTANTDB_ADMIN_TOKEN,
      schema: schema as Parameters<typeof init>[0]["schema"],
    });
  }
  return adminDb;
}

/**
 * Create an auth user and return their $users ID.
 * This creates a user in InstantDB's auth system if they don't exist.
 */
export async function createAuthUser(email: string): Promise<string> {
  const db = getAdminDb();
  // createToken creates the user if they don't exist, returns a token
  await db.auth.createToken(email);
  // getUser retrieves the user record with the ID
  const user = await db.auth.getUser({ email });
  return user.id;
}

/**
 * Create a test database client that queries as a specific user.
 * This client respects permission rules (unlike the admin client).
 */
export function initTestDatabaseAsUser(email: string): TestInstantDBClient {
  const db = getAdminDb();
  const userDb = db.asUser({ email });

  const client: TestInstantDBClient = {
    __adminDb: db,

    async query<T = unknown>(queryObj: Record<string, unknown>): Promise<T> {
      const result = await userDb.query(
        queryObj as Parameters<UserScopedDB["query"]>[0]
      );
      return result as T;
    },

    async transact(chunks: TxChunk | TxChunk[]): Promise<TransactionResult> {
      const chunksArray = Array.isArray(chunks) ? chunks : [chunks];
      const result = await userDb.transact(
        chunksArray as Parameters<UserScopedDB["transact"]>[0]
      );
      return result as TransactionResult;
    },

    subscribeQuery<T = unknown>(
      queryObj: Record<string, unknown>,
      callback: SubscriptionCallback<T>
    ): Unsubscribe {
      const subscription = userDb.subscribeQuery(
        queryObj as Parameters<UserScopedDB["subscribeQuery"]>[0],
        (result: { error?: Error; data?: Record<string, unknown[]> }) => {
          if (result.error) {
            callback({ error: { message: result.error.message }, data: undefined });
          } else {
            callback({ data: result.data as T });
          }
        }
      );
      return () => subscription.close();
    },

    tx: userDb.tx as InstantDBClient["tx"],
  };

  return client;
}

export function initTestDatabase(): TestInstantDBClient {
  adminDb = init({
    appId: TEST_INSTANTDB_APP_ID,
    adminToken: TEST_INSTANTDB_ADMIN_TOKEN,
    // Cast schema to work around type incompatibility between @instantdb/react and @instantdb/admin
    schema: schema as Parameters<typeof init>[0]["schema"],
  });

  const client: TestInstantDBClient = {
    __adminDb: adminDb,

    async query<T = unknown>(queryObj: Record<string, unknown>): Promise<T> {
      // Cast query to admin SDK's expected type
      const result = await adminDb!.query(
        queryObj as Parameters<AdminDB["query"]>[0]
      );
      return result as T;
    },

    async transact(chunks: TxChunk | TxChunk[]): Promise<TransactionResult> {
      const chunksArray = Array.isArray(chunks) ? chunks : [chunks];
      const result = await adminDb!.transact(
        chunksArray as Parameters<AdminDB["transact"]>[0]
      );
      return result as TransactionResult;
    },

    subscribeQuery<T = unknown>(
      queryObj: Record<string, unknown>,
      callback: SubscriptionCallback<T>
    ): Unsubscribe {
      const subscription = adminDb!.subscribeQuery(
        queryObj as Parameters<AdminDB["subscribeQuery"]>[0],
        (result: { error?: Error; data?: Record<string, unknown[]> }) => {
          if (result.error) {
            callback({ error: { message: result.error.message }, data: undefined });
          } else {
            callback({ data: result.data as T });
          }
        }
      );
      // Admin SDK returns an object with close() method
      return () => subscription.close();
    },

    tx: adminDb!.tx as InstantDBClient["tx"],
  };

  return client;
}

// Unique ID generator for test isolation (deprecated - use id() instead for UUIDs)
export function testId(prefix: string = "test"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Setup helper that initializes DB and configures entity metadata
export function setupTestDatabase(): TestInstantDBClient {
  // Configure the entity system with test schema
  // Note: Entities are auto-registered via @model decorator on import
  configureEntityMeta(schema as Parameters<typeof configureEntityMeta>[0]);

  return initTestDatabase();
}

// Helper to wait for async operations and MobX reactions
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Helper to wait for subscription to receive data
export function waitForSubscription<T>(
  db: TestInstantDBClient,
  queryObj: Record<string, unknown>,
  predicate: (data: T) => boolean,
  timeoutMs: number = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Subscription timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const unsubscribe = db.subscribeQuery<T>(queryObj, ({ error, data }) => {
      if (error) {
        clearTimeout(timeout);
        unsubscribe();
        reject(new Error(error.message));
        return;
      }
      if (data && predicate(data)) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(data);
      }
    });
  });
}

// Helper to wait a specified amount of time (for subscription propagation)
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper to wait for a condition to become true (for subscription-based tests)
export async function waitFor(
  condition: () => boolean,
  timeoutMs: number = 5000,
  intervalMs: number = 50
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms`);
    }
    await wait(intervalMs);
  }
}

// Cleanup helper to delete test entities by IDs
export async function cleanupTestEntities(
  db: TestInstantDBClient,
  entities: { entityType: string; ids: string[] }[]
): Promise<void> {
  const txChunks: TxChunk[] = [];

  for (const { entityType, ids } of entities) {
    for (const entityId of ids) {
      txChunks.push(
        (db.tx as Record<string, Record<string, { delete: () => TxChunk }>>)[
          entityType
        ][entityId].delete()
      );
    }
  }

  if (txChunks.length > 0) {
    await db.transact(txChunks);
  }
}
