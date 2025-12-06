import { describe, it, expect, beforeEach } from "vitest";
import {
  setupTestDatabase,
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
  function createUser(name = "Test User"): User {
    return new User(name);
  }

  function createPost(title = "Test Post"): Post {
    return new Post(title);
  }

  describe("isDirty() - after save", () => {
    it("hydrated entity is not dirty", async () => {
      const user = createUser();
      await store.save(user);

      // Hydrate from DB
      const [hydratedUser] = await store.queryModel(User);
      expect(hydratedUser!.isDirty()).toBe(false);
    });

    it("returns true after changing string field on saved entity", async () => {
      const user = createUser();
      await store.save(user);

      user.name = "New Name";

      expect(user.isDirty()).toBe(true);
    });

    it("returns true after changing date field on saved entity", async () => {
      const user = createUser();
      await store.save(user);

      user.updatedAt = new Date("2024-06-01");

      expect(user.isDirty()).toBe(true);
    });

    it("returns true after changing multiple fields on saved entity", async () => {
      const user = createUser();
      await store.save(user);

      user.name = "New Name";
      user.updatedAt = new Date();

      expect(user.isDirty()).toBe(true);
    });

    it("returns true after removing one-to-one relationship", async () => {
      const post = createPost();
      const user = createUser();

      // Save both entities and set up relationship
      await store.save(user);
      post.author = user;
      await store.save(post);

      // Now remove it
      post.author = null;

      expect(post.isDirty()).toBe(true);
    });

    it("returns true after removing from one-to-many relationship", async () => {
      const user = createUser();
      const post = createPost();

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
      const user = createUser();

      // New entity should be dirty (needs to be inserted)
      expect(user.isDirty()).toBe(true);

      await store.save(user);

      // Verify entity was saved to DB
      const result = await db.query({ users: { $: { where: { id: user.id } } } });
      expect((result as { users?: unknown[] }).users ?? []).toHaveLength(1);

      // After save, entity should no longer be dirty
      expect(user.isDirty()).toBe(false);
    });

    it("persists relationship set in constructor", async () => {
      // Create user first
      const user = createUser();
      await store.save(user);

      // Create post WITH author set in constructor (before initTracking)
      const post = new Post("Test Post", user);

      await store.save(post);

      // Verify relationship was persisted
      const result = await db.query({
        posts: {
          $: { where: { id: post.id } },
          author: {},
        },
      });
      const savedPost = (result as { posts?: Array<{ author?: { id: string } }> }).posts?.[0];
      expect(savedPost?.author?.id).toBe(user.id);  // This should FAIL without _isNew for relationships
    });

    it("does nothing when hydrated entity is not modified", async () => {
      // First create the entity in DB
      const user = createUser();
      await store.save(user);

      // Hydrate the entity from DB (simulates app restart or sync)
      const [hydratedUser] = await store.queryModel(User);
      expect(hydratedUser).toBeDefined();
      expect(hydratedUser!.isDirty()).toBe(false);

      // Save should do nothing (no changes)
      await store.save(hydratedUser!);
    });

    it("persists scalar changes to database", async () => {
      const user = createUser("New Name");
      await store.save(user);

      // Verify in database
      const result = await db.query({ users: { $: { where: { id: user.id } } } });
      const savedUser = (result as { users?: Array<{ name: string }> }).users?.[0];
      expect(savedUser).toBeDefined();
      expect(savedUser!.name).toBe("New Name");
    });

    it("persists relationship link to database", async () => {
      const post = createPost();
      const user = createUser();

      // Save user first, then link and save post
      await store.save(user);
      post.author = user;
      await store.save(post);

      // Verify relationship in database
      const result = await db.query({
        posts: {
          $: { where: { id: post.id } },
          author: {},
        },
      });
      const savedPost = (result as { posts?: Array<{ author?: { id: string } }> }).posts?.[0];
      expect(savedPost?.author?.id).toBe(user.id);
    });

    it("persists relationship unlink to database", async () => {
      const post = createPost();
      const user = createUser();

      // Save user, link to post and save
      await store.save(user);
      post.author = user;
      await store.save(post);

      // Verify link exists
      let result = await db.query({
        posts: {
          $: { where: { id: post.id } },
          author: {},
        },
      });
      expect((result as { posts?: Array<{ author?: { id: string } }> }).posts?.[0]?.author?.id).toBe(user.id);

      // Now remove the relationship
      post.author = null;
      await store.save(post);

      // Verify unlinked
      result = await db.query({
        posts: {
          $: { where: { id: post.id } },
          author: {},
        },
      });
      expect((result as { posts?: Array<{ author?: { id: string } | null }> }).posts?.[0]?.author).toBeNull();
    });

    it("converts Date to ISO string", async () => {
      const testDate = new Date("2024-06-15T10:30:00.000Z");
      const user = new User("Test");
      user.testDate = testDate;
      await store.save(user);

      // Verify date was saved correctly
      const result = await db.query({ users: { $: { where: { id: user.id } } } });
      const savedUser = (result as { users?: Array<{ testDate: string }> }).users?.[0];
      expect(savedUser?.testDate).toBe(testDate.toISOString());
    });
  });

  describe("save() - state after save", () => {
    it("isDirty returns false after successful save", async () => {
      const user = createUser();

      expect(user.isDirty()).toBe(true);
      await store.save(user);
      expect(user.isDirty()).toBe(false);
    });

    it("new changes are tracked after save", async () => {
      const user = createUser();
      await store.save(user);

      expect(user.isDirty()).toBe(false);

      user.name = "Second Change";

      expect(user.isDirty()).toBe(true);
    });
  });

  describe("automatic timestamps", () => {
    it("updates updatedAt automatically on save()", async () => {
      const user = createUser();
      const originalUpdatedAt = user.updatedAt;

      // Wait a bit to ensure time difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      user.name = "Changed";
      await store.save(user);

      expect(user.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
    });

    it("does not change createdAt on subsequent saves", async () => {
      const user = createUser();
      const originalCreatedAt = user.createdAt;

      await store.save(user);

      // Wait and save again
      await new Promise((resolve) => setTimeout(resolve, 10));
      user.name = "Changed";
      await store.save(user);

      expect(user.createdAt).toEqual(originalCreatedAt);
    });

    it("persists createdAt and updatedAt to database", async () => {
      const user = createUser();
      await store.save(user);

      const result = await db.query({ users: { $: { where: { id: user.id } } } });
      const savedUser = (result as { users?: Array<{ createdAt: string; updatedAt: string }> }).users?.[0];

      expect(savedUser?.createdAt).toBe(user.createdAt.toISOString());
      expect(savedUser?.updatedAt).toBe(user.updatedAt.toISOString());
    });

    it("hydrates createdAt and updatedAt from database", async () => {
      const user = createUser();
      const originalCreatedAt = user.createdAt;
      await store.save(user);

      // Create a fresh store to simulate hydrating from DB without local cache
      const freshStore = new RootStore({ db });
      const users = await freshStore.queryModel(User);
      const hydratedUser = users.find((u) => u.id === user.id);

      expect(hydratedUser).toBeDefined();
      expect(hydratedUser!.createdAt).toBeInstanceOf(Date);
      expect(hydratedUser!.updatedAt).toBeInstanceOf(Date);
      // Hydrated createdAt should match what was originally saved
      expect(hydratedUser!.createdAt.toISOString()).toBe(originalCreatedAt.toISOString());
    });
  });
});
