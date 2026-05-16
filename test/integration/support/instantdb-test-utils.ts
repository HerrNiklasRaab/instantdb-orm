import {
  getAdminDb as sharedGetAdminDb,
  initTestDatabase as sharedInitTestDatabase,
  initTestDatabaseAsUser as sharedInitTestDatabaseAsUser,
  seedAuthUser as sharedSeedAuthUser,
  type TestInstantDBClient as SharedTestInstantDBClient,
} from "@upfor/shared/test";
import type { InstantDBClient } from "../../../src/object-graph/persistence/types";
import { configureEntityMeta } from "../../../src/object-graph";
import schema from "../../support/instant.schema";

// Side-effect imports: @model decorator auto-registers these entities
import "../../support/entities/User";
import "../../support/entities/Profile";
import "../../support/entities/Post";
import "../../support/entities/Tag";
import "../../support/entities/Container";
import "../../support/entities/Item";
// STI entities (single table with type discriminator)
import "../../support/entities/ChessInvitation";
import "../../support/entities/SkiInvitation";
// MTI entities (separate tables)
import "../../support/entities/ChessMatch";
import "../../support/entities/SkiMatch";

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

export function seedAuthUser(email: string): Promise<string> {
  return sharedSeedAuthUser(
    schema as Parameters<typeof sharedSeedAuthUser>[0],
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
