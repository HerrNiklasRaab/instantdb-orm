import { describe, it, expect, beforeEach } from "vitest";
import {
  setupTestDatabase,
  id,
  flushMicrotasks,
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

  // Helper to create entities
  function createUser(userId: string): User {
    return store.create(User, userId);
  }

  function createPost(postId: string): Post {
    return store.create(Post, postId);
  }

  describe("isDirty() - scalar changes", () => {
    it("returns false for unchanged entity", async () => {
      const user = createUser(id());
      await flushMicrotasks();

      expect(user.isDirty()).toBe(false);
    });

    it("returns true after changing string field", async () => {
      const user = createUser(id());
      await flushMicrotasks();

      user.name = "New Name";

      expect(user.isDirty()).toBe(true);
    });

    it("returns true after changing date field", async () => {
      const user = createUser(id());
      await flushMicrotasks();

      user.updatedAt = new Date("2024-06-01");

      expect(user.isDirty()).toBe(true);
    });

    it("returns true after changing multiple fields", async () => {
      const user = createUser(id());
      await flushMicrotasks();

      user.name = "New Name";
      user.updatedAt = new Date();

      expect(user.isDirty()).toBe(true);
    });
  });

  describe("isDirty() - relationship changes", () => {
    it("returns true after assigning one-to-one relationship", async () => {
      const post = createPost(id());
      const user = createUser(id());
      await flushMicrotasks();

      post.author = user;

      expect(post.isDirty()).toBe(true);
    });

    it("returns true after removing one-to-one relationship", async () => {
      const postId = id();
      const userId = id();
      const post = createPost(postId);
      const user = createUser(userId);
      await flushMicrotasks();

      // First save the user with all required fields
      user.name = "Test User";
      user.createdAt = new Date();
      user.updatedAt = new Date();
      await user.save();

      // Set up initial relationship and save
      post.author = user;
      post.title = "Test Post";
      post.createdAt = new Date();
      post.updatedAt = new Date();
      await post.save();

      // Now remove it
      post.author = null;

      expect(post.isDirty()).toBe(true);
    });

    it("returns true after adding to one-to-many relationship", async () => {
      const user = createUser(id());
      const post = createPost(id());
      await flushMicrotasks();

      user.posts.push(post);

      expect(user.isDirty()).toBe(true);
    });

    it("returns true after removing from one-to-many relationship", async () => {
      const userId = id();
      const postId = id();
      const user = createUser(userId);
      const post = createPost(postId);
      await flushMicrotasks();

      // Save user first
      user.name = "Test User";
      user.createdAt = new Date();
      user.updatedAt = new Date();
      await user.save();

      // Save post with required fields
      post.title = "Test Post";
      post.createdAt = new Date();
      post.updatedAt = new Date();
      await post.save();

      // Set up initial relationship and save
      user.posts.push(post);
      await user.save();

      // Now remove it
      user.posts.pop();

      expect(user.isDirty()).toBe(true);
    });
  });

  describe("save() - basic flow", () => {
    it("does nothing when entity is not dirty", async () => {
      const userId = id();
      const user = createUser(userId);
      await flushMicrotasks();

      await user.save();

      // Verify nothing was saved to DB (entity shouldn't exist)
      const result = await db.query({ users: { $: { where: { id: userId } } } });
      expect((result as { users?: unknown[] }).users ?? []).toHaveLength(0);
    });

    it("persists scalar changes to database", async () => {
      const userId = id();
      const user = createUser(userId);
      await flushMicrotasks();

      user.name = "New Name";
      user.createdAt = new Date();
      user.updatedAt = new Date();
      await user.save();

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
      await flushMicrotasks();

      // First save the user
      user.name = "Test User";
      user.createdAt = new Date();
      user.updatedAt = new Date();
      await user.save();

      // Then link post to user
      post.title = "Test Post";
      post.createdAt = new Date();
      post.updatedAt = new Date();
      post.author = user;
      await post.save();

      // Verify relationship in database
      const result = await db.query({
        posts: {
          $: { where: { id: postId } },
          author: {},
        },
      });
      // InstantDB returns has-one relationships as single objects, not arrays
      const savedPost = (result as { posts?: Array<{ author?: { id: string } }> }).posts?.[0];
      expect(savedPost?.author?.id).toBe(userId);
    });

    it("persists relationship unlink to database", async () => {
      const postId = id();
      const userId = id();
      const post = createPost(postId);
      const user = createUser(userId);
      await flushMicrotasks();

      // First save the user
      user.name = "Test User";
      user.createdAt = new Date();
      user.updatedAt = new Date();
      await user.save();

      // Set up and save initial relationship
      post.title = "Test Post";
      post.createdAt = new Date();
      post.updatedAt = new Date();
      post.author = user;
      await post.save();

      // Verify link exists (has-one returns object, not array)
      let result = await db.query({
        posts: {
          $: { where: { id: postId } },
          author: {},
        },
      });
      expect((result as { posts?: Array<{ author?: { id: string } }> }).posts?.[0]?.author?.id).toBe(userId);

      // Now remove the relationship
      post.author = null;
      await post.save();

      // Verify unlinked (author should be null/undefined when unlinked)
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
      const user = createUser(userId);
      await flushMicrotasks();

      const testDate = new Date("2024-06-15T10:30:00.000Z");
      user.name = "Test";
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
      const user = createUser(userId);
      await flushMicrotasks();

      user.name = "New Name";
      user.createdAt = new Date();
      user.updatedAt = new Date();
      expect(user.isDirty()).toBe(true);

      await user.save();

      expect(user.isDirty()).toBe(false);
    });

    it("new changes are tracked after save", async () => {
      const userId = id();
      const user = createUser(userId);
      await flushMicrotasks();

      user.name = "First Change";
      user.createdAt = new Date();
      user.updatedAt = new Date();
      await user.save();

      expect(user.isDirty()).toBe(false);

      user.name = "Second Change";

      expect(user.isDirty()).toBe(true);
    });
  });
});
