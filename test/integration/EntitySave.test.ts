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
  });

  describe("save() - basic flow", () => {
    it("persists relationship set in constructor", async () => {
      // Create user first
      const user = createUser();
      await store.save(user);

      // Create post WITH author set in constructor (before initTracking)
      const post = new Post("Test Post", user);
      await store.save(post);

      // Verify via fresh store (query User first to populate identity map)
      const freshStore = new RootStore({ db });
      await freshStore.queryModel(User);
      const posts = await freshStore.queryModel(Post);
      const hydratedPost = posts.find((p) => p.id === post.id);

      expect(hydratedPost).toBeDefined();
      expect(hydratedPost!.author?.id).toBe(user.id);
    });

    it("persists scalar changes to database", async () => {
      const user = createUser("New Name");
      await store.save(user);

      // Verify via fresh store
      const freshStore = new RootStore({ db });
      const users = await freshStore.queryModel(User);
      const hydratedUser = users.find((u) => u.id === user.id);

      expect(hydratedUser).toBeDefined();
      expect(hydratedUser!.name).toBe("New Name");
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

  describe("save() - one-to-one relationships", () => {
    it("persists link via post.author = user", async () => {
      const post = createPost();
      const user = createUser();

      await store.save(user);
      post.author = user;

      // Assert isDirty before save
      expect(post.isDirty()).toBe(true);

      await store.save(post);

      // Verify via fresh store
      const freshStore = new RootStore({ db });
      const users = await freshStore.queryModel(User);
      const posts = await freshStore.queryModel(Post);
      const hydratedPost = posts.find((p) => p.id === post.id);
      const hydratedUser = users.find((u) => u.id === user.id);

      // Forward: Post.author → User
      expect(hydratedPost?.author?.id).toBe(user.id);
      // Reverse: User.posts → Post[]
      expect(hydratedUser?.posts.length).toBe(1);
      expect(hydratedUser?.posts[0]).toBe(hydratedPost);
    });

    it("persists unlink via post.author = null", async () => {
      const post = createPost();
      const user = createUser();

      // Setup: link author
      await store.save(user);
      post.author = user;
      await store.save(post);

      // Unlink and assert isDirty
      post.author = null;
      expect(post.isDirty()).toBe(true);

      await store.save(post);

      // Verify via fresh store
      const freshStore = new RootStore({ db });
      const users = await freshStore.queryModel(User);
      const posts = await freshStore.queryModel(Post);
      const hydratedPost = posts.find((p) => p.id === post.id);
      const hydratedUser = users.find((u) => u.id === user.id);

      // Forward: Post.author → null
      expect(hydratedPost?.author).toBeNull();
      // Reverse: User.posts → empty
      expect(hydratedUser?.posts.length).toBe(0);
    });
  });

  describe("save() - one-to-many relationships", () => {
    it("persists link via user.posts.push(post)", async () => {
      const user = createUser();
      const post = createPost();

      await store.save(user);
      await store.save(post);
      user.posts.push(post);

      // Assert isDirty before save
      expect(user.isDirty()).toBe(true);

      await store.save(user);

      // Verify via fresh store
      const freshStore = new RootStore({ db });
      const posts = await freshStore.queryModel(Post);
      const users = await freshStore.queryModel(User);
      const hydratedUser = users.find((u) => u.id === user.id);
      const hydratedPost = posts.find((p) => p.id === post.id);

      // Reverse: User.posts → Post[]
      expect(hydratedUser?.posts.length).toBe(1);
      expect(hydratedUser?.posts[0]).toBe(hydratedPost);
      // Forward: Post.author → User
      expect(hydratedPost?.author).toBe(hydratedUser);
    });

    it("persists unlink via removing from user.posts", async () => {
      const user = createUser();
      const post = createPost();

      // Setup: link post
      await store.save(user);
      await store.save(post);
      user.posts.push(post);
      await store.save(user);

      // Remove and assert isDirty
      user.posts.pop();
      expect(user.isDirty()).toBe(true);

      await store.save(user);

      // Verify via fresh store
      const freshStore = new RootStore({ db });
      const posts = await freshStore.queryModel(Post);
      const users = await freshStore.queryModel(User);
      const hydratedUser = users.find((u) => u.id === user.id);
      const hydratedPost = posts.find((p) => p.id === post.id);

      // Reverse: User.posts → empty
      expect(hydratedUser?.posts.length).toBe(0);
      // Forward: Post.author → null
      expect(hydratedPost?.author).toBeNull();
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

    it("persists and hydrates createdAt and updatedAt correctly", async () => {
      const user = createUser();
      const originalCreatedAt = user.createdAt;
      const originalUpdatedAt = user.updatedAt;
      await store.save(user);

      // Create a fresh store to simulate hydrating from DB without local cache
      const freshStore = new RootStore({ db });
      const users = await freshStore.queryModel(User);
      const hydratedUser = users.find((u) => u.id === user.id);

      expect(hydratedUser).toBeDefined();
      expect(hydratedUser!.createdAt).toBeInstanceOf(Date);
      expect(hydratedUser!.updatedAt).toBeInstanceOf(Date);
      expect(hydratedUser!.createdAt.toISOString()).toBe(originalCreatedAt.toISOString());
      expect(hydratedUser!.updatedAt.toISOString()).toBe(originalUpdatedAt.toISOString());
    });
  });
});
