import {
  getAdminDb as sharedGetAdminDb,
  initTestDatabase as sharedInitTestDatabase,
  initTestDatabaseAsUser as sharedInitTestDatabaseAsUser,
  createAuthUser as sharedCreateAuthUser,
  type TestInstantDBClient as SharedTestInstantDBClient,
} from "@upfor/shared/test";
import type { InstantDBClient } from "../../src/object-graph/persistence/types";
import { configureEntityMeta } from "../../src/object-graph";
import schema from "../instant.schema";

// Side-effect imports: @model decorator auto-registers these entities
import "../entities/User";
import "../entities/Profile";
import "../entities/Post";
import "../entities/Tag";
import "../entities/Container";
import "../entities/Item";
// STI entities (single table with type discriminator)
import "../entities/ChessInvitation";
import "../entities/SkiInvitation";
// MTI entities (separate tables)
import "../entities/ChessMatch";
import "../entities/SkiMatch";

// Re-export shared utilities so existing call sites don't have to change.
export {
  id,
  flushMicrotasks,
  wait,
  waitFor,
  waitForSubscription,
  cleanupTestEntities,
} from "@upfor/shared/test";

/**
 * Locally typed alias of the shared client. Both packages cast their wrapped
 * admin client to their own `InstantDBClient` so test code keeps the typed
 * surface it expects (query relations, tx tables, etc.).
 */
export type TestInstantDBClient = SharedTestInstantDBClient & InstantDBClient;

export function getAdminDb() {
  return sharedGetAdminDb(schema as Parameters<typeof sharedGetAdminDb>[0]);
}

export function initTestDatabase(): TestInstantDBClient {
  return sharedInitTestDatabase(
    schema as Parameters<typeof sharedInitTestDatabase>[0]
  ) as TestInstantDBClient;
}

export function initTestDatabaseAsUser(email: string): TestInstantDBClient {
  return sharedInitTestDatabaseAsUser(
    schema as Parameters<typeof sharedInitTestDatabaseAsUser>[0],
    email
  ) as TestInstantDBClient;
}

export function createAuthUser(email: string): Promise<string> {
  return sharedCreateAuthUser(
    schema as Parameters<typeof sharedCreateAuthUser>[0],
    email
  );
}

/** Configure entity metadata then return a fresh admin-context client. */
export function setupTestDatabase(): TestInstantDBClient {
  configureEntityMeta(schema as Parameters<typeof configureEntityMeta>[0]);
  return initTestDatabase();
}

// Unique ID generator for test isolation (deprecated — prefer `id()`).
export function testId(prefix: string = "test"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
