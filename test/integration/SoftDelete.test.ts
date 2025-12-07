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

  describe("store.delete()", () => {
    it("sets deletedAt, persists to DB, and removes from identity map on re-hydration", async () => {
      // Setup
      const user = new User("Test User");
      await store.save(user);

      // Hydrate in storeB FIRST (entity in identity map)
      const storeB = new RootStore({ db });
      await storeB.queryModel(User);
      expect(storeB.getById(User, user.id)).toBeDefined();

      // Delete via store.delete()
      expect(user.deletedAt).toBeNull();
      await store.delete(user);
      expect(user.deletedAt).toBeInstanceOf(Date);

      // Verify deletedAt is persisted to DB
      const result = await db.query({ users: { $: { where: { id: user.id } } } });
      const users = (result as { users?: { deletedAt?: string }[] }).users ?? [];
      expect(users).toHaveLength(1);
      expect(users[0]?.deletedAt).toBeDefined();

      // Re-hydrate in storeB → triggers cleanup
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
      // Setup in store
      const user = new User("Test User");
      const post = new Post("Test Post");
      post.author = user;
      await store.save(user);
      await store.save(post);

      // Hydrate in storeB FIRST (entity in identity map)
      const storeB = new RootStore({ db });
      await storeB.queryModel(User);
      await storeB.queryModel(Post);
      const hydratedPost = storeB.getById(Post, post.id);
      expect(hydratedPost?.author).toBeDefined();

      // Delete in store (simulates deletion on another device)
      await store.delete(user);

      // Re-hydrate in storeB → triggers cleanup
      await storeB.queryModel(User);

      // Verify cleanup happened
      expect(storeB.getById(User, user.id)).toBeUndefined();
      expect(hydratedPost?.author).toBeNull();
    });

    it("removes post from user.posts when post is deleted", async () => {
      // Setup in store
      const user = new User("Test User");
      const post1 = new Post("Post 1");
      const post2 = new Post("Post 2");
      post1.author = user;
      post2.author = user;
      await store.save(user);
      await store.save(post1);
      await store.save(post2);

      // Hydrate in storeB FIRST (entities in identity map)
      const storeB = new RootStore({ db });
      await storeB.queryModel(User);
      await storeB.queryModel(Post);
      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser?.posts.length).toBe(2);

      // Delete in store (simulates deletion on another device)
      await store.delete(post1);

      // Re-hydrate in storeB → triggers cleanup
      await storeB.queryModel(Post);

      // Verify cleanup happened
      expect(storeB.getById(Post, post1.id)).toBeUndefined();
      expect(hydratedUser?.posts.length).toBe(1);
      expect(hydratedUser?.posts[0]?.id).toBe(post2.id);
    });
  });

  describe("relationship cleanup - one-to-one (User ↔ Profile)", () => {
    it("nullifies user.profile when profile is deleted", async () => {
      // Setup in store
      const user = new User("Test User");
      const profile = new UserProfile();
      user.profile = profile;
      await store.save(user);
      await store.save(profile);

      // Hydrate in storeB FIRST (entity in identity map)
      const storeB = new RootStore({ db });
      await storeB.queryModel(User);
      await storeB.queryModel(UserProfile);
      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser?.profile).toBeDefined();

      // Delete in store (simulates deletion on another device)
      await store.delete(profile);

      // Re-hydrate in storeB → triggers cleanup
      await storeB.queryModel(UserProfile);

      // Verify cleanup happened
      expect(storeB.getById(UserProfile, profile.id)).toBeUndefined();
      expect(hydratedUser?.profile).toBeNull();
    });
  });
});
