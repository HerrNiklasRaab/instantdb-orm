import { describe, it, expect, beforeEach } from "vitest";
import {
  setupTestDatabase,
  type TestInstantDBClient,
} from "../utils/instantdb-test-utils";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { User } from "../entities/User";
import { Post } from "../entities/Post";
import { UserProfile } from "../entities/Profile";

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

  function createProfile(): UserProfile {
    return new UserProfile();
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

      user.testDate = new Date("2024-06-01");

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

  describe("save() - one-to-one relationships (User ↔ Profile)", () => {
    it("persists link and unlink", async () => {
      const user = createUser();
      const profile = createProfile();

      await store.save(user);
      await store.save(profile);

      // Link
      user.profile = profile;
      expect(user.isDirty()).toBe(true);
      await store.save(user);

      // Verify link via same store (rehydration clears relationship correctly)
      await store.queryModel(User);
      await store.queryModel(UserProfile);

      expect(user.profile).toBe(profile);
      expect(profile.user).toBe(user);

      // Verify link via fresh store
      let freshStore = new RootStore({ db });
      let users = await freshStore.queryModel(User);
      let profiles = await freshStore.queryModel(UserProfile);
      let hydratedUser = users.find((u) => u.id === user.id);
      let hydratedProfile = profiles.find((p) => p.id === profile.id);

      expect(hydratedUser?.profile).toBe(hydratedProfile);
      expect(hydratedProfile?.user).toBe(hydratedUser);

      // Unlink
      user.profile = null;
      expect(user.isDirty()).toBe(true);
      await store.save(user);

      // Verify unlink via same store (rehydration clears relationship correctly)
      await store.queryModel(User);
      await store.queryModel(UserProfile);

      expect(user.profile).toBeNull();
      expect(profile.user).toBeNull();

      // Verify unlink via fresh store
      freshStore = new RootStore({ db });
      users = await freshStore.queryModel(User);
      profiles = await freshStore.queryModel(UserProfile);
      hydratedUser = users.find((u) => u.id === user.id);
      hydratedProfile = profiles.find((p) => p.id === profile.id);

      expect(hydratedUser?.profile).toBeNull();
      expect(hydratedProfile?.user).toBeNull();
    });
  });

  describe("save() - one-to-many relationships (Post ↔ User)", () => {
    it("persists link and unlink via collection (user.posts)", async () => {
      const user = createUser();
      const post = createPost();

      await store.save(user);
      await store.save(post);

      // Link via collection
      user.posts.push(post);
      expect(user.isDirty()).toBe(true);
      await store.save(user);

      // Verify link via same store (rehydration)
      await store.queryModel(Post);
      await store.queryModel(User);

      expect(user.posts.length).toBe(1);
      expect(user.posts[0]).toBe(post);
      expect(post.author).toBe(user);

      // Verify link via fresh store
      let freshStore = new RootStore({ db });
      let posts = await freshStore.queryModel(Post);
      let users = await freshStore.queryModel(User);
      let hydratedUser = users.find((u) => u.id === user.id);
      let hydratedPost = posts.find((p) => p.id === post.id);

      expect(hydratedUser?.posts.length).toBe(1);
      expect(hydratedUser?.posts[0]).toBe(hydratedPost);
      expect(hydratedPost?.author).toBe(hydratedUser);

      // Unlink via collection
      user.posts.pop();
      expect(user.isDirty()).toBe(true);
      await store.save(user);

      // Verify unlink via same store (rehydration)
      await store.queryModel(Post);
      await store.queryModel(User);

      expect(user.posts.length).toBe(0);
      expect(post.author).toBeNull();

      // Verify unlink via fresh store
      freshStore = new RootStore({ db });
      posts = await freshStore.queryModel(Post);
      users = await freshStore.queryModel(User);
      hydratedUser = users.find((u) => u.id === user.id);
      hydratedPost = posts.find((p) => p.id === post.id);

      expect(hydratedUser?.posts.length).toBe(0);
      expect(hydratedPost?.author).toBeNull();
    });

    it("persists link and unlink via reference (post.author)", async () => {
      const post = createPost();
      const user = createUser();

      await store.save(user);
      await store.save(post);

      // Link via reference
      post.author = user;
      expect(post.isDirty()).toBe(true);
      await store.save(post);

      // Verify link via same store (rehydration)
      await store.queryModel(User);
      await store.queryModel(Post);

      expect(post.author).toBe(user);
      expect(user.posts.length).toBe(1);
      expect(user.posts[0]).toBe(post);

      // Verify link via fresh store
      let freshStore = new RootStore({ db });
      let users = await freshStore.queryModel(User);
      let posts = await freshStore.queryModel(Post);
      let hydratedPost = posts.find((p) => p.id === post.id);
      let hydratedUser = users.find((u) => u.id === user.id);

      expect(hydratedPost?.author).toBe(hydratedUser);
      expect(hydratedUser?.posts.length).toBe(1);
      expect(hydratedUser?.posts[0]).toBe(hydratedPost);

      // Unlink via reference
      post.author = null;
      expect(post.isDirty()).toBe(true);
      await store.save(post);

      // Verify unlink via same store (rehydration)
      await store.queryModel(User);
      await store.queryModel(Post);

      expect(post.author).toBeNull();
      expect(user.posts.length).toBe(0);

      // Verify unlink via fresh store
      freshStore = new RootStore({ db });
      users = await freshStore.queryModel(User);
      posts = await freshStore.queryModel(Post);
      hydratedPost = posts.find((p) => p.id === post.id);
      hydratedUser = users.find((u) => u.id === user.id);

      expect(hydratedPost?.author).toBeNull();
      expect(hydratedUser?.posts.length).toBe(0);
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
      await store.save(user);

      // Capture after save - this is what's persisted to DB
      const savedCreatedAt = user.createdAt;
      const savedUpdatedAt = user.updatedAt;

      // Create a fresh store to simulate hydrating from DB without local cache
      const freshStore = new RootStore({ db });
      const users = await freshStore.queryModel(User);
      const hydratedUser = users.find((u) => u.id === user.id);

      expect(hydratedUser).toBeDefined();
      expect(hydratedUser!.createdAt).toBeInstanceOf(Date);
      expect(hydratedUser!.updatedAt).toBeInstanceOf(Date);
      expect(hydratedUser!.createdAt.toISOString()).toBe(savedCreatedAt.toISOString());
      expect(hydratedUser!.updatedAt.toISOString()).toBe(savedUpdatedAt.toISOString());
    });
  });
});
