import { describe, it, expect, beforeEach } from "vitest";
import {
  setupTestDatabase,
  type TestInstantDBClient,
} from "../utils/instantdb-test-utils";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { User } from "../entities/User";
import { Post } from "../entities/Post";

describe("Transaction (Integration)", () => {
  let db: TestInstantDBClient;
  let store: RootStore;

  beforeEach(() => {
    db = setupTestDatabase();
    store = new RootStore({ db });
  });

  /** Creates a fresh store to verify persistence */
  function createVerificationStore(): RootStore {
    return new RootStore({ db });
  }

  function createUser(name = "Test User"): User {
    return new User(name);
  }

  function createPost(title = "Test Post"): Post {
    return new Post(title);
  }

  describe("startTransaction / commitTransaction", () => {
    it("commits multiple model changes atomically", async () => {
      // Create and save initial entities
      const user1 = createUser("User 1");
      const user2 = createUser("User 2");
      await store.save(user1);
      await store.save(user2);

      // Start transaction
      store.startTransaction();

      // Make changes to both entities
      user1.name = "Updated User 1";
      user2.name = "Updated User 2";

      // Commit transaction
      await store.commitTransaction();

      // Verify changes were persisted via fresh store
      const storeB = createVerificationStore();
      await storeB.queryModel(User);

      expect(storeB.getById(User, user1.id)?.name).toBe("Updated User 1");
      expect(storeB.getById(User, user2.id)?.name).toBe("Updated User 2");
    });

    it("resets change trackers after commit", async () => {
      const user = createUser();
      await store.save(user);

      store.startTransaction();
      user.name = "Changed";
      expect(user.isDirty()).toBe(true);

      await store.commitTransaction();

      expect(user.isDirty()).toBe(false);
    });

    it("throws error when starting nested transaction", () => {
      store.startTransaction();

      expect(() => store.startTransaction()).toThrow("Transaction already active");

      // Clean up
      store.undoTransaction();
    });

    it("throws error when committing without active transaction", async () => {
      await expect(store.commitTransaction()).rejects.toThrow("No active transaction");
    });
  });

  describe("undoTransaction - scalar rollback", () => {
    it("restores scalar field changes on rollback", async () => {
      const user = createUser("Original Name");
      await store.save(user);

      store.startTransaction();
      user.name = "Changed Name";

      expect(user.name).toBe("Changed Name");

      store.undoTransaction();

      expect(user.name).toBe("Original Name");
    });

    it("restores multiple scalar fields on rollback", async () => {
      const user = createUser("Original");
      const originalDate = user.testDate;
      await store.save(user);

      store.startTransaction();
      user.name = "Changed";
      user.testDate = new Date("2024-01-01");

      store.undoTransaction();

      expect(user.name).toBe("Original");
      expect(user.testDate).toEqual(originalDate);
    });

    it("entity is not dirty after rollback", async () => {
      const user = createUser();
      await store.save(user);

      store.startTransaction();
      user.name = "Changed";
      expect(user.isDirty()).toBe(true);

      store.undoTransaction();

      expect(user.isDirty()).toBe(false);
    });

    it("throws error when undoing without active transaction", () => {
      expect(() => store.undoTransaction()).toThrow("No active transaction");
    });
  });

  describe("undoTransaction - new model rollback", () => {
    it("removes new model from identity map on rollback", async () => {
      // Start with an existing user
      const existingUser = createUser("Existing");
      await store.save(existingUser);

      store.startTransaction();

      // Create a new user during transaction
      const newUser = createUser("New User");

      // Verify new user is in identity map
      expect(store.getById(User, newUser.id)).toBe(newUser);

      store.undoTransaction();

      // New user should be removed from identity map
      expect(store.getById(User, newUser.id)).toBeUndefined();

      // Existing user should still be there
      expect(store.getById(User, existingUser.id)).toBe(existingUser);
    });
  });

  describe("undoTransaction - relationship rollback", () => {
    it("restores to-one relationship on rollback", async () => {
      const user = createUser();
      const post = createPost();
      await store.save(user);
      post.author = user;
      await store.save(post);

      store.startTransaction();

      // Change the relationship
      const newUser = createUser("New Author");
      await store.save(newUser);
      post.author = newUser;

      expect(post.author).toBe(newUser);

      store.undoTransaction();

      expect(post.author).toBe(user);
    });

    it("restores to-one relationship to null on rollback", async () => {
      const user = createUser();
      const post = createPost();
      await store.save(user);
      await store.save(post);

      // Post has no author initially
      expect(post.author).toBeNull();

      store.startTransaction();
      post.author = user;
      expect(post.author).toBe(user);

      store.undoTransaction();

      expect(post.author).toBeNull();
    });

    it("restores to-many relationship on rollback", async () => {
      const user = createUser();
      const post1 = createPost("Post 1");
      const post2 = createPost("Post 2");

      await store.save(user);
      await store.save(post1);
      await store.save(post2);

      user.posts.push(post1);
      await store.save(user);

      // User has one post
      expect(user.posts).toHaveLength(1);
      expect(user.posts[0]).toBe(post1);

      store.startTransaction();

      // Add another post
      user.posts.push(post2);
      expect(user.posts).toHaveLength(2);

      store.undoTransaction();

      // Should be back to one post
      expect(user.posts).toHaveLength(1);
      expect(user.posts[0]).toBe(post1);
    });

    it("restores removed items in to-many relationship on rollback", async () => {
      const user = createUser();
      const post = createPost();

      await store.save(user);
      await store.save(post);

      user.posts.push(post);
      await store.save(user);

      expect(user.posts).toHaveLength(1);

      store.startTransaction();

      // Remove the post
      user.posts.pop();
      expect(user.posts).toHaveLength(0);

      store.undoTransaction();

      expect(user.posts).toHaveLength(1);
      expect(user.posts[0]).toBe(post);
    });
  });

  describe("empty transaction", () => {
    it("commits successfully with no changes", async () => {
      const user = createUser();
      await store.save(user);

      store.startTransaction();
      // No changes made
      await store.commitTransaction();

      // Should not throw, entity unchanged
      expect(user.isDirty()).toBe(false);
    });

    it("undoes successfully with no changes", async () => {
      const user = createUser();
      await store.save(user);
      const originalName = user.name;

      store.startTransaction();
      // No changes made
      store.undoTransaction();

      expect(user.name).toBe(originalName);
    });
  });

  describe("hasActiveTransaction", () => {
    it("returns false when no transaction is active", () => {
      expect(store.hasActiveTransaction).toBe(false);
    });

    it("returns true when transaction is active", () => {
      store.startTransaction();
      expect(store.hasActiveTransaction).toBe(true);

      // Clean up
      store.undoTransaction();
    });

    it("returns false after commit", async () => {
      store.startTransaction();
      await store.commitTransaction();
      expect(store.hasActiveTransaction).toBe(false);
    });

    it("returns false after undo", () => {
      store.startTransaction();
      store.undoTransaction();
      expect(store.hasActiveTransaction).toBe(false);
    });
  });

  describe("save() during transaction", () => {
    it("save() works normally during active transaction", async () => {
      const user = createUser("Original");
      await store.save(user);

      store.startTransaction();

      // save() should work and persist immediately
      user.name = "Saved During Transaction";
      await store.save(user);

      // Verify it was persisted via fresh store
      const storeB = createVerificationStore();
      await storeB.queryModel(User);
      expect(storeB.getById(User, user.id)?.name).toBe("Saved During Transaction");

      // Complete the transaction (no additional changes to commit)
      await store.commitTransaction();
    });
  });

  describe("error handling", () => {
    it("clears transaction state even if commit fails", async () => {
      const user = createUser();
      await store.save(user);

      store.startTransaction();
      user.name = "Changed";

      // Mock a failed commit by replacing store.db.transact
      const originalTransact = store.db.transact.bind(store.db);
      store.db.transact = async () => {
        throw new Error("Simulated DB error");
      };

      try {
        await expect(store.commitTransaction()).rejects.toThrow("Simulated DB error");
      } finally {
        store.db.transact = originalTransact;
      }

      // Transaction should be cleared even after failure
      expect(store.hasActiveTransaction).toBe(false);
    });
  });
});
