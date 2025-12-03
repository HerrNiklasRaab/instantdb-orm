import { describe, it, expect, beforeEach } from "vitest";
import {
  setupTestDatabase,
  id,
  flushMicrotasks,
  type TestInstantDBClient,
} from "../utils/instantdb-test-utils";
import { User } from "../entities/User";
import { Account } from "../entities/Account";

describe("Entity Save (Integration)", () => {
  let db: TestInstantDBClient;

  beforeEach(() => {
    db = setupTestDatabase();
  });

  describe("isDirty() - scalar changes", () => {
    it("returns false for unchanged entity", async () => {
      const user = new User(id());
      await flushMicrotasks();

      expect(user.isDirty()).toBe(false);
    });

    it("returns true after changing string field", async () => {
      const user = new User(id());
      await flushMicrotasks();

      user.name = "New Name";

      expect(user.isDirty()).toBe(true);
    });

    it("returns true after changing boolean field", async () => {
      const user = new User(id());
      await flushMicrotasks();

      user.emailVerified = true;

      expect(user.isDirty()).toBe(true);
    });

    it("returns true after changing date field", async () => {
      const user = new User(id());
      await flushMicrotasks();

      user.updatedAt = new Date("2024-06-01");

      expect(user.isDirty()).toBe(true);
    });

    it("returns true after changing multiple fields", async () => {
      const user = new User(id());
      await flushMicrotasks();

      user.name = "New Name";
      user.email = "new@email.com";

      expect(user.isDirty()).toBe(true);
    });
  });

  describe("isDirty() - relationship changes", () => {
    it("returns true after assigning one-to-one relationship", async () => {
      const account = new Account(id());
      const user = new User(id());
      await flushMicrotasks();

      account.user = user;

      expect(account.isDirty()).toBe(true);
    });

    it("returns true after removing one-to-one relationship", async () => {
      const accountId = id();
      const userId = id();
      const account = new Account(accountId);
      const user = new User(userId);
      await flushMicrotasks();

      // First save the user with all required fields
      user.name = "Test User";
      user.email = `${userId}@test.com`;
      user.emailVerified = true;
      user.createdAt = new Date();
      user.updatedAt = new Date();
      await user.save();

      // Set up initial relationship and save
      account.user = user;
      account.providerId = "google";
      account.accountId = "g123";
      account.createdAt = new Date();
      account.updatedAt = new Date();
      await account.save();

      // Now remove it
      account.user = null;

      expect(account.isDirty()).toBe(true);
    });

    it("returns true after adding to one-to-many relationship", async () => {
      const user = new User(id());
      const account = new Account(id());
      await flushMicrotasks();

      user.accounts.push(account);

      expect(user.isDirty()).toBe(true);
    });

    it("returns true after removing from one-to-many relationship", async () => {
      const userId = id();
      const accountId = id();
      const user = new User(userId);
      const account = new Account(accountId);
      await flushMicrotasks();

      // Save user first
      user.name = "Test User";
      user.email = `${userId}@test.com`;
      user.emailVerified = true;
      user.createdAt = new Date();
      user.updatedAt = new Date();
      await user.save();

      // Save account with required fields
      account.providerId = "google";
      account.accountId = "acc123";
      account.createdAt = new Date();
      account.updatedAt = new Date();
      await account.save();

      // Set up initial relationship and save
      user.accounts.push(account);
      await user.save();

      // Now remove it
      user.accounts.pop();

      expect(user.isDirty()).toBe(true);
    });
  });

  describe("save() - basic flow", () => {
    it("does nothing when entity is not dirty", async () => {
      const userId = id();
      const user = new User(userId);
      await flushMicrotasks();

      await user.save();

      // Verify nothing was saved to DB (entity shouldn't exist)
      const result = await db.query({ users: { $: { where: { id: userId } } } });
      expect((result as { users?: unknown[] }).users ?? []).toHaveLength(0);
    });

    it("persists scalar changes to database", async () => {
      const userId = id();
      const user = new User(userId);
      await flushMicrotasks();

      user.name = "New Name";
      user.email = `${userId}@test.com`;
      user.emailVerified = true;
      user.createdAt = new Date();
      user.updatedAt = new Date();
      await user.save();

      // Verify in database
      const result = await db.query({ users: { $: { where: { id: userId } } } });
      const savedUser = (result as { users?: Array<{ name: string; email: string }> }).users?.[0];
      expect(savedUser).toBeDefined();
      expect(savedUser!.name).toBe("New Name");
      expect(savedUser!.email).toBe(`${userId}@test.com`);
    });

    it("persists relationship link to database", async () => {
      const accountId = id();
      const userId = id();
      const account = new Account(accountId);
      const user = new User(userId);
      await flushMicrotasks();

      // First save the user
      user.name = "Test User";
      user.email = `${userId}@test.com`;
      user.emailVerified = true;
      user.createdAt = new Date();
      user.updatedAt = new Date();
      await user.save();

      // Then link account to user
      account.providerId = "google";
      account.accountId = "g123";
      account.createdAt = new Date();
      account.updatedAt = new Date();
      account.user = user;
      await account.save();

      // Verify relationship in database
      const result = await db.query({
        accounts: {
          $: { where: { id: accountId } },
          user: {},
        },
      });
      // InstantDB returns has-one relationships as single objects, not arrays
      const savedAccount = (result as { accounts?: Array<{ user?: { id: string } }> }).accounts?.[0];
      expect(savedAccount?.user?.id).toBe(userId);
    });

    it("persists relationship unlink to database", async () => {
      const accountId = id();
      const userId = id();
      const account = new Account(accountId);
      const user = new User(userId);
      await flushMicrotasks();

      // First save the user
      user.name = "Test User";
      user.email = `${userId}@test.com`;
      user.emailVerified = true;
      user.createdAt = new Date();
      user.updatedAt = new Date();
      await user.save();

      // Set up and save initial relationship
      account.providerId = "google";
      account.accountId = "g123";
      account.createdAt = new Date();
      account.updatedAt = new Date();
      account.user = user;
      await account.save();

      // Verify link exists (has-one returns object, not array)
      let result = await db.query({
        accounts: {
          $: { where: { id: accountId } },
          user: {},
        },
      });
      expect((result as { accounts?: Array<{ user?: { id: string } }> }).accounts?.[0]?.user?.id).toBe(userId);

      // Now remove the relationship
      account.user = null;
      await account.save();

      // Verify unlinked (user should be null/undefined when unlinked)
      result = await db.query({
        accounts: {
          $: { where: { id: accountId } },
          user: {},
        },
      });
      expect((result as { accounts?: Array<{ user?: { id: string } | null }> }).accounts?.[0]?.user).toBeNull();
    });

    it("converts Date to ISO string", async () => {
      const userId = id();
      const user = new User(userId);
      await flushMicrotasks();

      const testDate = new Date("2024-06-15T10:30:00.000Z");
      user.name = "Test";
      user.email = `${userId}@test.com`;
      user.emailVerified = true;
      user.createdAt = new Date();
      user.updatedAt = testDate;
      await user.save();

      // Verify date was saved correctly
      const result = await db.query({ users: { $: { where: { id: userId } } } });
      const savedUser = (result as { users?: Array<{ updatedAt: string }> }).users?.[0];
      expect(savedUser?.updatedAt).toBe(testDate.toISOString());
    });
  });

  describe("save() - state after save", () => {
    it("isDirty returns false after successful save", async () => {
      const userId = id();
      const user = new User(userId);
      await flushMicrotasks();

      user.name = "New Name";
      user.email = `${userId}@test.com`;
      user.emailVerified = true;
      user.createdAt = new Date();
      user.updatedAt = new Date();
      expect(user.isDirty()).toBe(true);

      await user.save();

      expect(user.isDirty()).toBe(false);
    });

    it("new changes are tracked after save", async () => {
      const userId = id();
      const user = new User(userId);
      await flushMicrotasks();

      user.name = "First Change";
      user.email = `${userId}@test.com`;
      user.emailVerified = true;
      user.createdAt = new Date();
      user.updatedAt = new Date();
      await user.save();

      expect(user.isDirty()).toBe(false);

      user.name = "Second Change";

      expect(user.isDirty()).toBe(true);
    });
  });
});
