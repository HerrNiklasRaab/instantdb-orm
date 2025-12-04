import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { User } from "../entities/User";
import { Post } from "../entities/Post";
import {
  setupTestDatabase,
  id,
  type TestInstantDBClient,
} from "../utils/instantdb-test-utils";

describe("Soft Delete (Integration)", () => {
  let db: TestInstantDBClient;
  let rootStore: RootStore;

  beforeEach(() => {
    db = setupTestDatabase();
    rootStore = new RootStore({ db });
  });

  // Helper to mark entity as deleted directly in database (simulating deletion from another device)
  async function markAsDeletedInDb(entityType: string, entityId: string) {
    await db.transact([
      db.tx[entityType][entityId].update({
        deletedAt: new Date().toISOString(),
      }),
    ]);
  }

  // Helper to create test user directly in database
  async function createTestUserInDb(entityId: string, deleted = false) {
    await db.transact([
      db.tx.users[entityId].update({
        name: "Test User",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: deleted ? new Date().toISOString() : null,
      }),
    ]);
  }

  // Helper to create test post directly in database
  async function createTestPostInDb(entityId: string, authorId?: string, deleted = false) {
    let tx = db.tx.posts[entityId].update({
      title: "Test Post",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: deleted ? new Date().toISOString() : null,
    });

    if (authorId) {
      tx = tx.link({ author: authorId });
    }

    await db.transact([tx]);
  }

  describe("store.delete()", () => {
    it("sets deletedAt and persists to database", async () => {
      const userId = id();

      // First create the user in database
      await createTestUserInDb(userId);

      // Create entity for deletion
      const user = new User(userId, "Test User", new Date(), new Date());

      expect(user.deletedAt).toBeNull();

      await rootStore.delete(user);

      expect(user.deletedAt).toBeInstanceOf(Date);

      // Verify deletedAt is persisted in database
      const userResult = await db.query({ users: { $: { where: { id: userId } } } });
      const users = (userResult as { users?: { deletedAt?: string }[] }).users ?? [];
      expect(users).toHaveLength(1);
      expect(users[0]?.deletedAt).toBeDefined();
    });
  });

  describe("hydration of deleted entities", () => {
    it("removes deleted entities from identity map during hydration", async () => {
      const userId = id();

      // Create a deleted user in DB
      await createTestUserInDb(userId, true);

      // Hydrate via watchEntity
      const users = await rootStore.watchEntity(User);

      // Deleted user should not be in results
      expect(users.find((u) => u.id === userId)).toBeUndefined();

      // And not in identity map
      expect(rootStore.getById(User, userId)).toBeUndefined();
    });

    it("removes entity from identity map when deletedAt is set on existing entity", async () => {
      const userId = id();

      // Create a non-deleted user in DB
      await createTestUserInDb(userId, false);

      // First hydration - user should be present
      await rootStore.watchEntity(User);
      expect(rootStore.getById(User, userId)).toBeDefined();

      // Simulate deletion from another device
      await markAsDeletedInDb("users", userId);

      // Re-hydrate - user should be removed
      await rootStore.watchEntity(User);
      expect(rootStore.getById(User, userId)).toBeUndefined();
    });

    it("does not remove entities that are not deleted", async () => {
      const userId1 = id();
      const userId2 = id();

      // Create one normal user and one deleted user
      await createTestUserInDb(userId1, false);
      await createTestUserInDb(userId2, true);

      // Hydrate
      const users = await rootStore.watchEntity(User);

      // Only non-deleted user should be present
      expect(users.find((u) => u.id === userId1)).toBeDefined();
      expect(users.find((u) => u.id === userId2)).toBeUndefined();
      expect(rootStore.getById(User, userId1)).toBeDefined();
      expect(rootStore.getById(User, userId2)).toBeUndefined();
    });
  });

  describe("relationship cleanup", () => {
    it("sets forward reference to null when target is deleted during hydration", async () => {
      const userId = id();
      const postId = id();

      // Create entities in database - user is deleted
      await createTestUserInDb(userId, true);
      await createTestPostInDb(postId, userId);

      // Hydrate - deleted user should trigger cleanup
      await rootStore.watchEntity(User);
      await rootStore.watchEntity(Post);

      const post = rootStore.getById(Post, postId);
      expect(post).toBeDefined();
      // The author reference should be null since user was deleted
      expect(post?.author).toBeNull();
    });

    it("removes deleted entity from reverse arrays during hydration", async () => {
      const userId = id();
      const postId1 = id();
      const postId2 = id();

      // Create entities in database - post1 is deleted
      await createTestUserInDb(userId, false);
      await createTestPostInDb(postId1, userId, true);
      await createTestPostInDb(postId2, userId, false);

      // Hydrate all entities
      await rootStore.watchEntity(User);
      await rootStore.watchEntity(Post);

      const user = rootStore.getById(User, userId);
      expect(user).toBeDefined();

      // Only non-deleted post should be in the array
      expect(user?.posts.length).toBe(1);
      expect(user?.posts[0]?.id).toBe(postId2);
    });

    it("cleans up relationships when entity becomes deleted", async () => {
      const userId = id();
      const postId = id();

      // Create non-deleted entities
      await createTestUserInDb(userId, false);
      await createTestPostInDb(postId, userId, false);

      // First hydration - both entities present, relationship intact
      await rootStore.watchEntity(User);
      await rootStore.watchEntity(Post);

      const user = rootStore.getById(User, userId);
      const post = rootStore.getById(Post, postId);

      expect(user).toBeDefined();
      expect(post).toBeDefined();
      expect(post?.author).toBe(user);
      expect(user?.posts).toContain(post);

      // Mark user as deleted in DB
      await markAsDeletedInDb("users", userId);

      // Re-hydrate users - should clean up relationships
      await rootStore.watchEntity(User);

      // User should be removed
      expect(rootStore.getById(User, userId)).toBeUndefined();

      // Post's author reference should be cleaned up
      expect(post?.author).toBeNull();
    });
  });
});
