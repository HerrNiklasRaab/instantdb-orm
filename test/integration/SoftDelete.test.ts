import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { User } from "../entities/User";
import { Post } from "../entities/Post";
import { UserProfile } from "../entities/Profile";
import {
  setupTestDatabase,
  type TestInstantDBClient,
} from "../utils/instantdb-test-utils";

describe("Soft Delete (Integration)", () => {
  let db: TestInstantDBClient;
  let store: RootStore;

  beforeEach(() => {
    db = setupTestDatabase();
    store = new RootStore({ db });
  });

  // Helper to mark entity as deleted directly in database (simulating deletion from another device)
  async function markAsDeletedInDb(entityType: string, entityId: string) {
    await db.transact([
      db.tx[entityType][entityId].update({
        deletedAt: new Date().toISOString(),
      }),
    ]);
  }

  describe("store.delete()", () => {
    it("sets deletedAt and persists to database", async () => {
      // Setup via store
      const user = new User("Test User");
      await store.save(user);

      expect(user.deletedAt).toBeNull();

      await store.delete(user);

      expect(user.deletedAt).toBeInstanceOf(Date);

      // Verify via storeB
      const storeB = new RootStore({ db });
      await storeB.queryModel(User);

      // Deleted user not in storeB
      expect(storeB.getById(User, user.id)).toBeUndefined();

      // deletedAt is set in DB
      const result = await db.query({ users: { $: { where: { id: user.id } } } });
      const users = (result as { users?: { deletedAt?: string }[] }).users ?? [];
      expect(users).toHaveLength(1);
      expect(users[0]?.deletedAt).toBeDefined();
    });
  });

  describe("hydration of deleted entities", () => {
    it("removes deleted entities from identity map during hydration", async () => {
      // Setup via store
      const user = new User("Test User");
      await store.save(user);
      await store.delete(user);

      // Verify via storeB
      const storeB = new RootStore({ db });
      const users = await storeB.queryModel(User);

      // Deleted user should not be in results
      expect(users.find((u) => u.id === user.id)).toBeUndefined();
      expect(storeB.getById(User, user.id)).toBeUndefined();
    });

    it("removes entity from identity map when deletedAt is set on existing entity", async () => {
      // Setup via store
      const user = new User("Test User");
      await store.save(user);

      // First hydration - user should be present
      const storeB = new RootStore({ db });
      await storeB.queryModel(User);
      expect(storeB.getById(User, user.id)).toBeDefined();

      // Simulate deletion from another device
      await markAsDeletedInDb("users", user.id);

      // Re-hydrate - user should be removed
      await storeB.queryModel(User);
      expect(storeB.getById(User, user.id)).toBeUndefined();
    });

    it("does not remove entities that are not deleted", async () => {
      // Setup via store
      const user1 = new User("User 1");
      const user2 = new User("User 2");
      await store.save(user1);
      await store.save(user2);
      await store.delete(user2);

      // Verify via storeB
      const storeB = new RootStore({ db });
      const users = await storeB.queryModel(User);

      // Only non-deleted user should be present
      expect(users.find((u) => u.id === user1.id)).toBeDefined();
      expect(users.find((u) => u.id === user2.id)).toBeUndefined();
      expect(storeB.getById(User, user1.id)).toBeDefined();
      expect(storeB.getById(User, user2.id)).toBeUndefined();
    });
  });

  describe("relationship cleanup - one-to-many (Post ↔ User)", () => {
    it("nullifies post.author when user is deleted", async () => {
      // Setup via store
      const user = new User("Test User");
      const post = new Post("Test Post");
      post.author = user;
      await store.save(user);
      await store.save(post);
      await store.delete(user);

      // Verify via storeB
      const storeB = new RootStore({ db });
      await storeB.queryModel(User);
      await storeB.queryModel(Post);

      const hydratedPost = storeB.getById(Post, post.id);
      expect(hydratedPost).toBeDefined();
      expect(hydratedPost?.author).toBeNull();
    });

    it("removes post from user.posts when post is deleted", async () => {
      // Setup via store
      const user = new User("Test User");
      const post1 = new Post("Post 1");
      const post2 = new Post("Post 2");
      post1.author = user;
      post2.author = user;
      await store.save(user);
      await store.save(post1);
      await store.save(post2);
      await store.delete(post1);

      // Verify via storeB
      const storeB = new RootStore({ db });
      await storeB.queryModel(User);
      await storeB.queryModel(Post);

      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser).toBeDefined();
      expect(hydratedUser?.posts.length).toBe(1);
      expect(hydratedUser?.posts[0]?.id).toBe(post2.id);
    });
  });

  describe("relationship cleanup - one-to-one (User ↔ Profile)", () => {
    it("nullifies user.profile when profile is deleted", async () => {
      // Setup via store
      const user = new User("Test User");
      const profile = new UserProfile();
      user.profile = profile;
      await store.save(user);
      await store.save(profile);
      await store.delete(profile);

      // Verify via storeB
      const storeB = new RootStore({ db });
      await storeB.queryModel(User);
      await storeB.queryModel(UserProfile);

      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser).toBeDefined();
      expect(hydratedUser?.profile).toBeNull();
    });
  });

  describe("relationship cleanup - reactive sync", () => {
    it("cleans up relationships via reactive sync", async () => {
      // Setup via store
      const user = new User("Test User");
      const post = new Post("Test Post");
      post.author = user;
      await store.save(user);
      await store.save(post);

      // Set up reactive subscriptions
      await store.subscribeModel(User, () => { });
      await store.subscribeModel(Post, () => { });

      expect(post.author).toBe(user);
      expect(user.posts).toContain(post);

      // Mark user as deleted in DB (simulates deletion from another device)
      await markAsDeletedInDb("users", user.id);

      // Wait for reactive sync to process the deletion
      await new Promise((resolve) => setTimeout(resolve, 500));

      // User should be removed via reactive sync
      expect(store.getById(User, user.id)).toBeUndefined();

      // Post's author reference should be cleaned up
      expect(post.author).toBeNull();
    });
  });
});
