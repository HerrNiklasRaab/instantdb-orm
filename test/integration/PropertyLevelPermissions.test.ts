import { Transaction } from "../../src/transactions";
import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import {
  assertDefined,
  connectTestClient,
  connectTestClientAs,
  seedAuthUser,
  id,
  type TestClient,
} from "./support/clients";
import { User } from "../support/entities/User";

/**
 * Integration tests for property-level permissions.
 *
 * These tests verify that when the server withholds a field due to permissions,
 * the field is correctly hydrated as `undefined` in the model.
 *
 * The test uses the `secretField` on the User entity, which is restricted
 * so only the owner (auth.id == data.id) can see it.
 */
describe("Property-level permissions (Integration)", () => {
  let adminClient: TestClient;

  beforeEach(() => {
    // Admin client bypasses permissions - used for test setup
    adminClient = connectTestClient();
  });

  describe("secretField visibility", () => {
    it("owner can see their own secretField", async () => {
      const email = `owner-${id()}@example.com`;

      // 1. Create auth user and get their ID
      const authUserId = await seedAuthUser(email);

      // 2. Create test user with the SAME ID (so auth.id == data.id)
      await adminClient.commit(new Transaction().create("users", authUserId, {
          name: "Owner",
          secretField: "my-secret-value",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));

      // 3. Query as owner using TestStore with user-scoped client
      const ownerClient = connectTestClientAs(email);
      const ownerStore = new RootStore({ client: ownerClient });
      const users = await ownerStore.queryModel(User);
      const user = users.find((u) => u.id === authUserId);

      // Owner should be able to see all fields including secretField
      assertDefined(user);
      expect(user.name).toBe("Owner");
      expect(user.secretField).toBe("my-secret-value");
    });

    it("non-owner cannot see secretField (returns undefined)", async () => {
      const ownerEmail = `owner-${id()}@example.com`;
      const viewerEmail = `viewer-${id()}@example.com`;

      // Create owner and their user record
      const ownerId = await seedAuthUser(ownerEmail);
      await seedAuthUser(viewerEmail);

      await adminClient.commit(new Transaction().create("users", ownerId, {
          name: "Owner",
          secretField: "secret-only-owner-sees",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));

      // Query as viewer (not the owner)
      const viewerClient = connectTestClientAs(viewerEmail);
      const viewerStore = new RootStore({ client: viewerClient });
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
