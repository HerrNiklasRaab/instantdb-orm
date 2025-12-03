import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import {
  setupTestDatabase,
  id,
  flushMicrotasks,
  type TestInstantDBClient,
  TEST_ENTITY_REGISTRY,
} from "../utils/instantdb-test-utils";
import { User } from "../entities/User";
import { Account } from "../entities/Account";
import { $User } from "../entities/$User";

type TestRootStore = RootStore<typeof TEST_ENTITY_REGISTRY>;

describe("RootStore hydration (Integration)", () => {
  let db: TestInstantDBClient;
  let storeA: TestRootStore; // "Device A" - creates data
  let storeB: TestRootStore; // "Device B" - hydrates data

  beforeEach(() => {
    db = setupTestDatabase();
    storeA = new RootStore({ db });
    storeB = new RootStore({ db });
  });

  // Helper to create user through Store A (simulates another device creating data)
  async function createUserInStoreA(
    entityId: string,
    data: Partial<{
      name: string;
      email: string;
      emailVerified: boolean;
      createdAt: Date;
      updatedAt: Date;
    }>
  ): Promise<User> {
    const user = new User(entityId);
    storeA.getIdentityMap("users").set(user);
    await flushMicrotasks(); // Wait for tracking to initialize
    // Set ALL properties AFTER tracking is initialized so changes are captured
    // Note: We must change each field to trigger MobX observation, even if same as default
    user.name = data.name ?? "Test User";
    user.email = data.email ?? `${entityId}@test.com`;
    // Force a change by setting to opposite first, then to desired value
    user.emailVerified = !user.emailVerified;
    user.emailVerified = data.emailVerified ?? false;
    user.createdAt = data.createdAt ?? new Date();
    user.updatedAt = data.updatedAt ?? new Date();
    await user.save();
    return user;
  }

  // Helper to create account through Store A
  async function createAccountInStoreA(
    entityId: string,
    data: Partial<{
      providerId: string;
      accountId: string;
      user: User;
    }>
  ): Promise<Account> {
    const account = new Account(entityId);
    storeA.getIdentityMap("accounts").set(account);
    await flushMicrotasks(); // Wait for tracking to initialize
    // Set properties AFTER tracking is initialized so changes are captured
    account.providerId = data.providerId ?? "google";
    account.accountId = data.accountId ?? "acc123";
    account.createdAt = new Date();
    account.updatedAt = new Date();
    if (data.user) {
      account.user = data.user;
    }
    await account.save();
    return account;
  }

  // Helper to create $User through Store A
  async function create$UserInStoreA(
    entityId: string,
    data: Partial<{
      email: string;
      type: string;
      linkedPrimaryUser: $User;
      user: User;
    }>
  ): Promise<$User> {
    const $user = new $User(entityId);
    storeA.getIdentityMap("$users").set($user);
    await flushMicrotasks();
    $user.email = data.email;
    $user.type = data.type ?? "primary";
    if (data.linkedPrimaryUser) {
      $user.linkedPrimaryUser = data.linkedPrimaryUser;
    }
    if (data.user) {
      $user.user = data.user;
    }
    await $user.save();
    return $user;
  }

  // Helper to create account with dangling link directly in DB (for edge case tests)
  async function createAccountInDbWithDanglingLink(
    entityId: string,
    fakeUserId: string
  ) {
    await db.transact([
      db.tx.accounts[entityId]
        .update({
          providerId: "google",
          accountId: "acc123",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .link({ user: fakeUserId }),
    ]);
  }

  describe("basic hydration", () => {
    it("hydrates scalar fields correctly", async () => {
      const userId = id();

      // Store A creates user
      await createUserInStoreA(userId, {
        name: "John",
        email: `john-${userId}@test.com`,
        emailVerified: true,
      });

      // Store B hydrates and verifies (only users needed)
      const users = await storeB.watchEntity("users");
      const user = users.find((u) => u.id === userId);

      expect(user).toBeDefined();
      expect(user!.name).toBe("John");
      expect(user!.email).toBe(`john-${userId}@test.com`);
      expect(user!.emailVerified).toBe(true);
    });

    it("converts date fields to Date objects", async () => {
      const userId = id();
      const testDate = new Date("2024-01-01T00:00:00.000Z");

      // Store A creates user with specific dates
      await createUserInStoreA(userId, {
        createdAt: testDate,
        updatedAt: testDate,
      });

      // Store B hydrates and verifies dates are Date objects (only users needed)
      const users = await storeB.watchEntity("users");
      const user = users.find((u) => u.id === userId);

      expect(user!.createdAt).toBeInstanceOf(Date);
      expect(user!.updatedAt).toBeInstanceOf(Date);
    });

    it("uses identity map - same ID returns same instance", async () => {
      const userId = id();

      // Store A creates user
      await createUserInStoreA(userId, { name: "John" });

      // Store B hydrates first time (only users needed)
      const users1 = await storeB.watchEntity("users");
      const user1 = users1.find((u) => u.id === userId);

      // Store A updates user name
      const userA = storeA.getById("users", userId)!;
      userA.name = "John Updated";
      await userA.save();

      // Store B re-hydrates (only users needed)
      const users2 = await storeB.watchEntity("users");
      const user2 = users2.find((u) => u.id === userId);

      expect(user1).toBe(user2); // Same instance
      expect(user1!.name).toBe("John Updated"); // Updated value
    });
  });

  describe("forward link resolution", () => {
    it("sets forward relationship when target exists", async () => {
      const userId = id();
      const accountId = id();

      // Store A creates user and account with relationship
      const user = await createUserInStoreA(userId, { name: "John" });
      await createAccountInStoreA(accountId, { user });

      // Store B hydrates and verifies relationship
      await storeB.watchAll();
      const hydratedUser = storeB.getById("users", userId);
      const hydratedAccount = storeB.getById("accounts", accountId);

      expect(hydratedAccount!.user).toBe(hydratedUser);
    });

    it("sets reverse relationship on target (has many)", async () => {
      const userId = id();
      const accountId = id();

      // Store A creates user and account with relationship
      const user = await createUserInStoreA(userId, { name: "John" });
      await createAccountInStoreA(accountId, { user });

      // Store B hydrates and verifies reverse relationship
      await storeB.watchAll();
      const hydratedUser = storeB.getById("users", userId);
      const hydratedAccount = storeB.getById("accounts", accountId);

      expect(hydratedUser!.accounts).toContain(hydratedAccount);
      expect(hydratedUser!.accounts.length).toBe(1);
    });

    it("forward relationship is null when target does not exist yet", async () => {
      const accountId = id();
      const fakeUserId = id();

      // Create account with link to non-existent user directly in DB
      // (simulates corrupted data or data from another system)
      await createAccountInDbWithDanglingLink(accountId, fakeUserId);

      // Store B hydrates - should handle dangling reference gracefully (only accounts needed)
      const accounts = await storeB.watchEntity("accounts");
      const account = accounts.find((a) => a.id === accountId);

      expect(account!.user).toBeNull();
    });
  });

  describe("reverse link resolution", () => {
    it("updates existing forward entities when target is hydrated later", async () => {
      const userId = id();
      const accountId = id();

      // Create account with link to user that doesn't exist yet (direct DB)
      await createAccountInDbWithDanglingLink(accountId, userId);

      // Store B hydrates account first (before user exists) - only accounts needed
      const accounts = await storeB.watchEntity("accounts");
      const account = accounts.find((a) => a.id === accountId);
      expect(account!.user).toBeNull();

      // Now Store A creates the user
      await createUserInStoreA(userId, { name: "John" });

      // Store B re-hydrates everything to pick up the new user
      await storeB.watchAll();
      const user = storeB.getById("users", userId);

      // Account's user should now be resolved
      expect(account!.user).toBe(user);
      expect(user!.accounts).toContain(account);
    });

    it("handles multiple forward entities referencing same target", async () => {
      const userId = id();
      const accountId1 = id();
      const accountId2 = id();

      // Store A creates user and two accounts linked to it
      const user = await createUserInStoreA(userId, { name: "John" });
      await createAccountInStoreA(accountId1, { providerId: "google", user });
      await createAccountInStoreA(accountId2, { providerId: "github", user });

      // Store B hydrates and verifies all relationships
      await storeB.watchAll();
      const hydratedUser = storeB.getById("users", userId);
      const account1 = storeB.getById("accounts", accountId1);
      const account2 = storeB.getById("accounts", accountId2);

      expect(account1!.user).toBe(hydratedUser);
      expect(account2!.user).toBe(hydratedUser);
      expect(hydratedUser!.accounts).toContain(account1);
      expect(hydratedUser!.accounts).toContain(account2);
      expect(hydratedUser!.accounts.length).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("does not set relationship when no link exists", async () => {
      const accountId = id();

      // Store A creates account without user link
      await createAccountInStoreA(accountId, {});

      // Store B hydrates and verifies no relationship (only accounts needed)
      const accounts = await storeB.watchEntity("accounts");
      const account = accounts.find((a) => a.id === accountId);

      expect(account!.user).toBeNull();
    });

    it("does not duplicate relationships when entity is hydrated multiple times", async () => {
      const userId = id();
      const accountId = id();

      // Store A creates user and account with relationship
      const user = await createUserInStoreA(userId, { name: "John" });
      await createAccountInStoreA(accountId, { user });

      // Store B hydrates multiple times
      await storeB.watchAll();
      await storeB.watchAll();
      await storeB.watchAll();

      const hydratedUser = storeB.getById("users", userId);
      const hydratedAccount = storeB.getById("accounts", accountId);

      expect(hydratedUser!.accounts.length).toBe(1);
      expect(hydratedUser!.accounts[0]).toBe(hydratedAccount);
    });
  });

  describe("deeply nested query hydration", () => {
    it("hydrates 3-level nested relationships with where clause (User → $user → linkedGuestUsers)", async () => {
      const userId = id();
      const primary$UserId = id();
      const guestId1 = id();
      const guestId2 = id();

      // Create User
      const user = await createUserInStoreA(userId, { name: "Primary User" });

      // Create primary $User linked to User
      const primary$User = await create$UserInStoreA(primary$UserId, {
        email: `primary-${primary$UserId}@test.com`,
        type: "primary",
        user: user,
      });
      user.$user = primary$User;
      await user.save();

      // Create guest $User linked to primary
      await create$UserInStoreA(guestId1, {
        email: `guest1-${guestId1}@test.com`,
        type: "guest",
        linkedPrimaryUser: primary$User,
      });
      await create$UserInStoreA(guestId2, {
        email: `guest2-${guestId2}@test.com`,
        type: "guest",
        linkedPrimaryUser: primary$User,
      });

      // Store B hydrates using 3-level nested query with WHERE clause
      await storeB.query({
        users: {
          $: { where: { id: userId } },
          $user: {
            linkedGuestUsers: {},
          },
        },
      });

      // Get hydrated entities
      const hydratedUser = storeB.getById("users", userId);
      const hydratedPrimary = storeB.getById("$users", primary$UserId);
      const hydratedGuest1 = storeB.getById("$users", guestId1);
      const hydratedGuest2 = storeB.getById("$users", guestId2);

      // Level 1: User → $user
      expect(hydratedUser!.$user).toBe(hydratedPrimary);

      // Level 2: $user → linkedGuestUsers
      expect(hydratedPrimary!.linkedGuestUsers).toContain(hydratedGuest1);
      expect(hydratedPrimary!.linkedGuestUsers).toContain(hydratedGuest2);
      expect(hydratedPrimary!.linkedGuestUsers.length).toBe(2);

      // Level 3: Verify reverse relationships
      expect(hydratedGuest1!.linkedPrimaryUser).toBe(hydratedPrimary);
      expect(hydratedGuest2!.linkedPrimaryUser).toBe(hydratedPrimary);

      // Verify bidirectional User ↔ $User
      expect(hydratedPrimary!.user).toBe(hydratedUser);

      // Verify object identity across traversal paths
      expect(hydratedUser!.$user).toBe(hydratedGuest1!.linkedPrimaryUser);
      expect(hydratedUser!.$user!.linkedGuestUsers[0]).toBe(
        storeB.getById(
          "$users",
          hydratedUser!.$user!.linkedGuestUsers[0]!.id
        )
      );
    });
  });
});
