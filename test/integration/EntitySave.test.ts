import { describe, it, expect, beforeEach } from "vitest";
import {
  assertDefined,
  setupTestDatabase,
  type TestInstantDBClient,
} from "./support/instantdb-test-utils";
import { RootStore } from "../../src/object-graph/store/RootStore";
import type { AppSchema } from "../support/instant.schema";
import { User } from "../support/entities/User";
import { Post } from "../support/entities/Post";
import { UserProfile } from "../support/entities/Profile";

function firstUserWithTestDate(
  result: unknown
): { testDate: string } | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const users: unknown = Reflect.get(result, "users");
  if (!Array.isArray(users)) return undefined;
  const rows: unknown[] = users;
  const first: unknown = rows[0];
  if (typeof first !== "object" || first === null) return undefined;
  const testDate: unknown = Reflect.get(first, "testDate");
  if (typeof testDate !== "string") return undefined;
  return { testDate };
}

describe("Entity persistence via transaction (Integration)", () => {
  let db: TestInstantDBClient;
  let store: RootStore<AppSchema>;

  beforeEach(() => {
    db = setupTestDatabase();
    store = new RootStore<AppSchema>({ db });
  });

  function createUser(name = "Test User"): User {
    return new User(name);
  }

  function createPost(title = "Test Post"): Post {
    return new Post(title);
  }

  function createProfile(): UserProfile {
    return new UserProfile();
  }

  describe("basic flow", () => {
    it("persists relationship set in constructor", async () => {
      const user = await store.transaction(() => createUser());

      const post = await store.transaction(() => new Post("Test Post", user));

      // Verify via fresh store (query User first to populate identity map)
      const freshStore = new RootStore<AppSchema>({ db });
      await freshStore.queryModel(User);
      const posts = await freshStore.queryModel(Post);
      const hydratedPost = posts.find((p) => p.id === post.id);

      assertDefined(hydratedPost);
      expect(hydratedPost.author?.id).toBe(user.id);
    });

    it("persists scalar changes to database", async () => {
      const user = await store.transaction(() => createUser("New Name"));

      const freshStore = new RootStore<AppSchema>({ db });
      const users = await freshStore.queryModel(User);
      const hydratedUser = users.find((u) => u.id === user.id);

      assertDefined(hydratedUser);
      expect(hydratedUser.name).toBe("New Name");
    });

    it("converts Date to ISO string", async () => {
      const testDate = new Date("2024-06-15T10:30:00.000Z");
      const user = await store.transaction(() => {
        const u = new User("Test");
        u.testDate = testDate;
        return u;
      });

      const result = await db.query({ users: { $: { where: { id: user.id } } } });
      const savedUser = firstUserWithTestDate(result);
      expect(savedUser?.testDate).toBe(testDate.toISOString());
    });
  });

  describe("one-to-one relationships (User ↔ Profile)", () => {
    it("persists link and unlink", async () => {
      const user = await store.transaction(() => createUser());
      const profile = await store.transaction(() => createProfile());

      // Link
      await store.transaction(() => {
        user.profile = profile;
      });

      await store.queryModel(User);
      await store.queryModel(UserProfile);

      expect(user.profile).toBe(profile);
      expect(profile.user).toBe(user);

      let freshStore = new RootStore<AppSchema>({ db });
      let users = await freshStore.queryModel(User);
      let profiles = await freshStore.queryModel(UserProfile);
      let hydratedUser = users.find((u) => u.id === user.id);
      let hydratedProfile = profiles.find((p) => p.id === profile.id);

      expect(hydratedUser?.profile).toBe(hydratedProfile);
      expect(hydratedProfile?.user).toBe(hydratedUser);

      // Unlink
      await store.transaction(() => {
        user.profile = null;
      });

      await store.queryModel(User);
      await store.queryModel(UserProfile);

      expect(user.profile).toBeNull();
      expect(profile.user).toBeNull();

      freshStore = new RootStore<AppSchema>({ db });
      users = await freshStore.queryModel(User);
      profiles = await freshStore.queryModel(UserProfile);
      hydratedUser = users.find((u) => u.id === user.id);
      hydratedProfile = profiles.find((p) => p.id === profile.id);

      expect(hydratedUser?.profile).toBeNull();
      expect(hydratedProfile?.user).toBeNull();
    });
  });

  describe("one-to-many relationships (Post ↔ User)", () => {
    it("persists link and unlink via collection (user.posts)", async () => {
      const user = await store.transaction(() => createUser());
      const post = await store.transaction(() => createPost());

      // Link via collection
      await store.transaction(() => {
        user.posts.push(post);
      });

      await store.queryModel(Post);
      await store.queryModel(User);

      expect(user.posts.length).toBe(1);
      expect(user.posts[0]).toBe(post);
      expect(post.author).toBe(user);

      let freshStore = new RootStore<AppSchema>({ db });
      let posts = await freshStore.queryModel(Post);
      let users = await freshStore.queryModel(User);
      let hydratedUser = users.find((u) => u.id === user.id);
      let hydratedPost = posts.find((p) => p.id === post.id);

      expect(hydratedUser?.posts.length).toBe(1);
      expect(hydratedUser?.posts[0]).toBe(hydratedPost);
      expect(hydratedPost?.author).toBe(hydratedUser);

      // Unlink via collection
      await store.transaction(() => {
        user.posts.pop();
      });

      await store.queryModel(Post);
      await store.queryModel(User);

      expect(user.posts.length).toBe(0);
      expect(post.author).toBeNull();

      freshStore = new RootStore<AppSchema>({ db });
      posts = await freshStore.queryModel(Post);
      users = await freshStore.queryModel(User);
      hydratedUser = users.find((u) => u.id === user.id);
      hydratedPost = posts.find((p) => p.id === post.id);

      expect(hydratedUser?.posts.length).toBe(0);
      expect(hydratedPost?.author).toBeNull();
    });

    it("persists link and unlink via reference (post.author)", async () => {
      const post = await store.transaction(() => createPost());
      const user = await store.transaction(() => createUser());

      // Link via reference
      await store.transaction(() => {
        post.author = user;
      });

      await store.queryModel(User);
      await store.queryModel(Post);

      expect(post.author).toBe(user);
      expect(user.posts.length).toBe(1);
      expect(user.posts[0]).toBe(post);

      let freshStore = new RootStore<AppSchema>({ db });
      let users = await freshStore.queryModel(User);
      let posts = await freshStore.queryModel(Post);
      let hydratedPost = posts.find((p) => p.id === post.id);
      let hydratedUser = users.find((u) => u.id === user.id);

      expect(hydratedPost?.author).toBe(hydratedUser);
      expect(hydratedUser?.posts.length).toBe(1);
      expect(hydratedUser?.posts[0]).toBe(hydratedPost);

      // Unlink via reference
      await store.transaction(() => {
        post.author = null;
      });

      await store.queryModel(User);
      await store.queryModel(Post);

      expect(post.author).toBeNull();
      expect(user.posts.length).toBe(0);

      freshStore = new RootStore<AppSchema>({ db });
      users = await freshStore.queryModel(User);
      posts = await freshStore.queryModel(Post);
      hydratedPost = posts.find((p) => p.id === post.id);
      hydratedUser = users.find((u) => u.id === user.id);

      expect(hydratedPost?.author).toBeNull();
      expect(hydratedUser?.posts.length).toBe(0);
    });
  });

  describe("automatic timestamps", () => {
    it("updates updatedAt automatically on commit", async () => {
      const user = await store.transaction(() => createUser());
      const originalUpdatedAt = user.updatedAt;

      await new Promise((resolve) => setTimeout(resolve, 10));

      await store.transaction(() => {
        user.name = "Changed";
      });

      expect(user.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
    });

    it("does not change createdAt on subsequent commits", async () => {
      const user = await store.transaction(() => createUser());
      const originalCreatedAt = user.createdAt;

      await new Promise((resolve) => setTimeout(resolve, 10));
      await store.transaction(() => {
        user.name = "Changed";
      });

      expect(user.createdAt).toEqual(originalCreatedAt);
    });

    it("persists and hydrates createdAt and updatedAt correctly", async () => {
      const user = await store.transaction(() => createUser());

      const savedCreatedAt = user.createdAt;
      const savedUpdatedAt = user.updatedAt;

      const freshStore = new RootStore<AppSchema>({ db });
      const users = await freshStore.queryModel(User);
      const hydratedUser = users.find((u) => u.id === user.id);

      assertDefined(hydratedUser);
      expect(hydratedUser.createdAt).toBeInstanceOf(Date);
      expect(hydratedUser.updatedAt).toBeInstanceOf(Date);
      expect(hydratedUser.createdAt.toISOString()).toBe(savedCreatedAt.toISOString());
      expect(hydratedUser.updatedAt.toISOString()).toBe(savedUpdatedAt.toISOString());
    });
  });
});
