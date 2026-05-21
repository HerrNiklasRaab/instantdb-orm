import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import type { AppSchema } from "../support/instant.schema";
import {
  assertDefined,
  setupTestDatabase,
  initTestDatabaseAsUser,
  seedAuthUser,
  id,
  txFor,
  type TestInstantDBClient,
} from "./support/instantdb-test-utils";
import { User } from "../support/entities/User";

/**
 * Integration tests for property-level permissions.
 *
 * These tests verify that when InstantDB restricts a field due to permissions,
 * the field is correctly hydrated as `undefined` in the model.
 *
 * The test uses the `secretField` on the User entity, which is restricted
 * so only the owner (auth.id == data.id) can see it.
 */
describe("Property-level permissions (Integration)", () => {
  let adminDb: TestInstantDBClient;

  beforeEach(() => {
    // Admin client bypasses permissions - used for test setup
    adminDb = setupTestDatabase();
  });

  describe("secretField visibility", () => {
    it("owner can see their own secretField", async () => {
      const email = `owner-${id()}@example.com`;

      // 1. Create auth user and get their $users ID
      const authUserId = await seedAuthUser(email);

      // 2. Create test user with SAME ID as $users (so auth.id == data.id)
      await adminDb.__adminDb.transact([
        txFor(adminDb.__adminDb.tx, "users", authUserId).update({
          name: "Owner",
          secretField: "my-secret-value",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      ]);

      // 3. Query as owner using RootStore with user-scoped client
      const ownerDb = initTestDatabaseAsUser(email);
      const ownerStore = new RootStore<AppSchema>({ db: ownerDb });
      const users = await ownerStore.queryModel(User);
      const user = users.find((u) => u.id === authUserId);

      // Owner should be able to see all fields including secretField
      assertDefined(user);
      expect(user.name).toBe("Owner");
      expect(user.secretField).toBe("my-secret-value");
    });

    it("non-owner cannot see secretField (returns null)", async () => {
      const ownerEmail = `owner-${id()}@example.com`;
      const viewerEmail = `viewer-${id()}@example.com`;

      // Create owner and their user record
      const ownerId = await seedAuthUser(ownerEmail);
      await seedAuthUser(viewerEmail);

      await adminDb.__adminDb.transact([
        txFor(adminDb.__adminDb.tx, "users", ownerId).update({
          name: "Owner",
          secretField: "secret-only-owner-sees",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      ]);

      // Query as viewer (not the owner)
      const viewerDb = initTestDatabaseAsUser(viewerEmail);
      const viewerStore = new RootStore<AppSchema>({ db: viewerDb });
      const users = await viewerStore.queryModel(User);
      const user = users.find((u) => u.id === ownerId);

      // Viewer should see the user but NOT the secretField
      assertDefined(user);
      expect(user.name).toBe("Owner"); // Public field is visible
      // Restricted field is not returned - should remain undefined per type definition
      expect(user.secretField).toBeUndefined();
    });

  });
});
