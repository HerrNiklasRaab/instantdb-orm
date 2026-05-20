import {
  getAdminDb as sharedGetAdminDb,
  initTestDatabase as sharedInitTestDatabase,
  initTestDatabaseAsUser as sharedInitTestDatabaseAsUser,
  seedAuthUser as sharedSeedAuthUser,
  type TestInstantDBClient as SharedTestInstantDBClient,
} from "@upfor/shared/test";
import { configureEntityMeta } from "../../../src/object-graph";
import schema, { type AppSchema } from "../../support/instant.schema";

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

export type TestInstantDBClient = SharedTestInstantDBClient<AppSchema>;

export function getAdminDb() {
  return sharedGetAdminDb<AppSchema>(schema);
}

export function initTestDatabase(): TestInstantDBClient {
  return sharedInitTestDatabase<AppSchema>(schema);
}

export function initTestDatabaseAsUser(email: string): TestInstantDBClient {
  return sharedInitTestDatabaseAsUser<AppSchema>(schema, email);
}

export function seedAuthUser(email: string): Promise<string> {
  return sharedSeedAuthUser<AppSchema>(schema, email);
}

/** Configure entity metadata then return a fresh admin-context client. */
export function setupTestDatabase(): TestInstantDBClient {
  configureEntityMeta(schema);
  return initTestDatabase();
}

// Unique ID generator for test isolation (deprecated — prefer `id()`).
export function testId(prefix: string = "test"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

export function assertDefined<T>(
  value: T | null | undefined,
  message: string = "expected value to be defined"
): asserts value is NonNullable<T> {
  if (value == null) throw new Error(message);
}
