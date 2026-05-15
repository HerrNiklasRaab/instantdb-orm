import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { User } from "../support/entities/User";
import { Post } from "../support/entities/Post";
import { UserProfile } from "../support/entities/Profile";
import {
  setupTestDatabase,
  type TestInstantDBClient,
} from "./support/instantdb-test-utils";

describe("Soft Delete (Integration)", () => {
  let db: TestInstantDBClient;
  let store: RootStore;

  beforeEach(() => {
    db = setupTestDatabase();
    store = new RootStore({ db });
  });

  describe("model.delete()", () => {
    it("sets deletedAt, persists to DB, and removes from identity map on re-hydration", async () => {
      const user = await store.transaction(() => new User("Test User"));

      // Hydrate in storeB FIRST (entity in identity map)
      const storeB = new RootStore({ db });
      await storeB.queryModel(User);
      expect(storeB.getById(User, user.id)).toBeDefined();

      expect(user.deletedAt).toBeNull();
      await store.transaction(() => user.delete());
      expect(user.deletedAt).toBeInstanceOf(Date);

      const result = await db.query({ users: { $: { where: { id: user.id } } } });
      const users = (result as { users?: { deletedAt?: string }[] }).users ?? [];
      expect(users).toHaveLength(1);
      expect(users[0]?.deletedAt).toBeDefined();

      // Re-hydrate in storeB → triggers cleanup
      await storeB.queryModel(User);
      expect(storeB.getById(User, user.id)).toBeUndefined();
    });

    it("does not remove entities that are not deleted", async () => {
      const user1 = await store.transaction(() => new User("User 1"));
      const user2 = await store.transaction(() => new User("User 2"));
      await store.transaction(() => user2.delete());

      const storeB = new RootStore({ db });
      const users = await storeB.queryModel(User);

      expect(users.find((u) => u.id === user1.id)).toBeDefined();
      expect(users.find((u) => u.id === user2.id)).toBeUndefined();
      expect(storeB.getById(User, user1.id)).toBeDefined();
      expect(storeB.getById(User, user2.id)).toBeUndefined();
    });
  });

  describe("relationship cleanup - one-to-many (Post ↔ User)", () => {
    it("nullifies post.author when user is deleted", async () => {
      const user = await store.transaction(() => new User("Test User"));
      const post = await store.transaction(() => {
        const p = new Post("Test Post");
        p.author = user;
        return p;
      });

      // Hydrate in storeB FIRST (entity in identity map)
      const storeB = new RootStore({ db });
      await storeB.queryModel(User);
      await storeB.queryModel(Post);
      const hydratedPost = storeB.getById(Post, post.id);
      expect(hydratedPost?.author).toBeDefined();

      await store.transaction(() => user.delete());

      await storeB.queryModel(User);

      expect(storeB.getById(User, user.id)).toBeUndefined();
      expect(hydratedPost?.author).toBeNull();
    });

    it("removes post from user.posts when post is deleted", async () => {
      const user = await store.transaction(() => new User("Test User"));
      const [post1, post2] = await store.transaction(() => {
        const p1 = new Post("Post 1");
        const p2 = new Post("Post 2");
        p1.author = user;
        p2.author = user;
        return [p1, p2] as const;
      });

      const storeB = new RootStore({ db });
      await storeB.queryModel(User);
      await storeB.queryModel(Post);
      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser?.posts.length).toBe(2);

      await store.transaction(() => post1.delete());

      await storeB.queryModel(Post);

      expect(storeB.getById(Post, post1.id)).toBeUndefined();
      expect(hydratedUser?.posts.length).toBe(1);
      expect(hydratedUser?.posts[0]?.id).toBe(post2.id);
    });
  });

  describe("relationship cleanup - one-to-one (User ↔ Profile)", () => {
    it("nullifies user.profile when profile is deleted", async () => {
      const user = await store.transaction(() => new User("Test User"));
      const profile = await store.transaction(() => {
        const p = new UserProfile();
        user.profile = p;
        return p;
      });

      const storeB = new RootStore({ db });
      await storeB.queryModel(User);
      await storeB.queryModel(UserProfile);
      const hydratedUser = storeB.getById(User, user.id);
      expect(hydratedUser?.profile).toBeDefined();

      await store.transaction(() => profile.delete());

      await storeB.queryModel(UserProfile);

      expect(storeB.getById(UserProfile, profile.id)).toBeUndefined();
      expect(hydratedUser?.profile).toBeNull();
    });
  });
});
