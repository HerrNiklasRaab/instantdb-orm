import { describe, it, expect, beforeEach } from "vitest";
import {
  setupTestDatabase,
  id,
  type TestInstantDBClient,
} from "../utils/instantdb-test-utils";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { User } from "../entities/User";
import { Post } from "../entities/Post";

describe("Entity Save (Integration)", () => {
  let db: TestInstantDBClient;
  let store: RootStore;

  beforeEach(() => {
    db = setupTestDatabase();
    store = new RootStore({ db });
  });

  // Helper to create entities with default values
  function createUser(userId: string, name = "Test User"): User {
    return new User(userId, { name, createdAt: new Date(), updatedAt: new Date() });
  }

  function createPost(postId: string, title = "Test Post"): Post {
    return new Post(postId, { title, createdAt: new Date(), updatedAt: new Date() });
  }

  describe("isDirty() - new entity behavior", () => {
    it("new entity is dirty (needs to be inserted)", () => {
      const user = createUser(id());
      expect(user.isDirty()).toBe(true);
    });

    it("hydrated entity is not dirty", async () => {
      const userId = id();
      const user = createUser(userId);
      await store.save(user);

      // Hydrate from DB
      const [hydratedUser] = await store.queryModel(User);
      expect(hydratedUser!.isDirty()).toBe(false);
    });
  });

  describe("isDirty() - scalar changes", () => {
    it("returns true after changing string field on saved entity", async () => {
      const user = createUser(id());
      await store.save(user);

      user.name = "New Name";

      expect(user.isDirty()).toBe(true);
    });

    it("returns true after changing date field on saved entity", async () => {
      const user = createUser(id());
      await store.save(user);

      user.updatedAt = new Date("2024-06-01");

      expect(user.isDirty()).toBe(true);
    });

    it("returns true after changing multiple fields on saved entity", async () => {
      const user = createUser(id());
      await store.save(user);

      user.name = "New Name";
      user.updatedAt = new Date();

      expect(user.isDirty()).toBe(true);
    });
  });

  describe("isDirty() - relationship changes", () => {
    it("returns true after assigning one-to-one relationship", () => {
      const post = createPost(id());
      const user = createUser(id());

      post.author = user;

      expect(post.isDirty()).toBe(true);
    });

    it("returns true after removing one-to-one relationship", async () => {
      const post = createPost(id());
      const user = createUser(id());

      // Save both entities and set up relationship
      await store.save(user);
      post.author = user;
      await store.save(post);

      // Now remove it
      post.author = null;

      expect(post.isDirty()).toBe(true);
    });

    it("returns true after adding to one-to-many relationship", () => {
      const user = createUser(id());
      const post = createPost(id());

      user.posts.push(post);

      expect(user.isDirty()).toBe(true);
    });

    it("returns true after removing from one-to-many relationship", async () => {
      const user = createUser(id());
      const post = createPost(id());

      // Save entities with relationship
      await store.save(user);
      await store.save(post);
      user.posts.push(post);
      await store.save(user);

      // Now remove it
      user.posts.pop();

      expect(user.isDirty()).toBe(true);
    });
  });

  describe("save() - basic flow", () => {
    it("new entity is persisted on first save", async () => {
      const userId = id();
      const user = createUser(userId);

      // New entity should be dirty (needs to be inserted)
      expect(user.isDirty()).toBe(true);

      await store.save(user);

      // Verify entity was saved to DB
      const result = await db.query({ users: { $: { where: { id: userId } } } });
      expect((result as { users?: unknown[] }).users ?? []).toHaveLength(1);

      // After save, entity should no longer be dirty
      expect(user.isDirty()).toBe(false);
    });

    it("does nothing when hydrated entity is not modified", async () => {
      const userId = id();

      // First create the entity in DB
      const user = createUser(userId);
      await store.save(user);

      // Hydrate the entity from DB (simulates app restart or sync)
      const [hydratedUser] = await store.queryModel(User);
      expect(hydratedUser).toBeDefined();
      expect(hydratedUser!.isDirty()).toBe(false);

      // Save should do nothing (no changes)
      await store.save(hydratedUser!);
    });

    it("persists scalar changes to database", async () => {
      const userId = id();
      const user = createUser(userId, "New Name");
      await store.save(user);

      // Verify in database
      const result = await db.query({ users: { $: { where: { id: userId } } } });
      const savedUser = (result as { users?: Array<{ name: string }> }).users?.[0];
      expect(savedUser).toBeDefined();
      expect(savedUser!.name).toBe("New Name");
    });

    it("persists relationship link to database", async () => {
      const postId = id();
      const userId = id();
      const post = createPost(postId);
      const user = createUser(userId);

      // Save user first, then link and save post
      await store.save(user);
      post.author = user;
      await store.save(post);

      // Verify relationship in database
      const result = await db.query({
        posts: {
          $: { where: { id: postId } },
          author: {},
        },
      });
      const savedPost = (result as { posts?: Array<{ author?: { id: string } }> }).posts?.[0];
      expect(savedPost?.author?.id).toBe(userId);
    });

    it("persists relationship unlink to database", async () => {
      const postId = id();
      const userId = id();
      const post = createPost(postId);
      const user = createUser(userId);

      // Save user, link to post and save
      await store.save(user);
      post.author = user;
      await store.save(post);

      // Verify link exists
      let result = await db.query({
        posts: {
          $: { where: { id: postId } },
          author: {},
        },
      });
      expect((result as { posts?: Array<{ author?: { id: string } }> }).posts?.[0]?.author?.id).toBe(userId);

      // Now remove the relationship
      post.author = null;
      await store.save(post);

      // Verify unlinked
      result = await db.query({
        posts: {
          $: { where: { id: postId } },
          author: {},
        },
      });
      expect((result as { posts?: Array<{ author?: { id: string } | null }> }).posts?.[0]?.author).toBeNull();
    });

    it("converts Date to ISO string", async () => {
      const userId = id();
      const testDate = new Date("2024-06-15T10:30:00.000Z");
      const user = new User(userId, { name: "Test", createdAt: new Date(), updatedAt: testDate });
      await store.save(user);

      // Verify date was saved correctly
      const result = await db.query({ users: { $: { where: { id: userId } } } });
      const savedUser = (result as { users?: Array<{ updatedAt: string }> }).users?.[0];
      expect(savedUser?.updatedAt).toBe(testDate.toISOString());
    });
  });

  describe("save() - state after save", () => {
    it("isDirty returns false after successful save", async () => {
      const userId = id();
      const user = createUser(userId);

      expect(user.isDirty()).toBe(true);
      await store.save(user);
      expect(user.isDirty()).toBe(false);
    });

    it("new changes are tracked after save", async () => {
      const userId = id();
      const user = createUser(userId);
      await store.save(user);

      expect(user.isDirty()).toBe(false);

      user.name = "Second Change";

      expect(user.isDirty()).toBe(true);
    });
  });
});
