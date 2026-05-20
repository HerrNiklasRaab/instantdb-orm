import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import type { AppSchema } from "../support/instant.schema";
import {
  assertDefined,
  setupTestDatabase,
  id,
  waitFor,
  type TestInstantDBClient,
} from "./support/instantdb-test-utils";
import { User } from "../support/entities/User";
import { Post } from "../support/entities/Post";
import { UserProfile } from "../support/entities/Profile";
// Import MTI entities to register them with model registry
import "../support/entities/ChessMatch";
import "../support/entities/SkiMatch";

describe("RootStore hydration (Integration)", () => {
  let db: TestInstantDBClient;
  let storeA: RootStore<AppSchema>; // "Device A" - creates data
  let storeB: RootStore<AppSchema>; // "Device B" - hydrates data

  beforeEach(() => {
    db = setupTestDatabase();
    storeA = new RootStore<AppSchema>({ db });
    storeB = new RootStore<AppSchema>({ db });
  });

  // Helper to create user through Store A (simulates another device creating data)
  async function createUserInStoreA(
    data: Partial<{
      name: string;
      testDate: Date;
    }> = {}
  ): Promise<User> {
    return storeA.transaction(() => {
      const user = new User(data.name ?? "Test User");
      if (data.testDate) {
        user.testDate = data.testDate;
      }
      return user;
    });
  }

  // Helper to create post through Store A
  async function createPostInStoreA(
    data: Partial<{
      title: string;
      content: string;
      author: User;
    }> = {}
  ): Promise<Post> {
    return storeA.transaction(() => {
      const post = new Post(data.title ?? "Test Post");
      post.content = data.content ?? null;
      if (data.author) {
        post.author = data.author;
      }
      return post;
    });
  }

  // Helper to create post through Store B
  async function createPostInStoreB(
    data: Partial<{
      title: string;
      content: string;
      author: User;
    }> = {}
  ): Promise<Post> {
    return storeB.transaction(() => {
      const post = new Post(data.title ?? "Test Post");
      post.content = data.content ?? null;
      if (data.author) {
        post.author = data.author;
      }
      return post;
    });
  }

  // Helper to create profile through Store A
  async function createProfileInStoreA(
    data: Partial<{
      bio: string;
      avatarUrl: string;
      user: User;
    }> = {}
  ): Promise<UserProfile> {
    return storeA.transaction(() => {
      const profile = new UserProfile();
      profile.bio = data.bio ?? null;
      profile.avatarUrl = data.avatarUrl ?? null;
      if (data.user) {
        profile.user = data.user;
      }
      return profile;
    });
  }

  // Helper to create post with dangling link directly in DB (for edge case tests)
  async function createPostInDbWithDanglingLink(
    entityId: string,
    fakeUserId: string
  ) {
    await db.transact([
      db.__adminDb.tx.posts[entityId]
        .update({
          title: "Test Post",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .link({ author: fakeUserId }),
    ]);
  }

  describe("basic hydration", () => {
    it("hydrates scalar fields correctly", async () => {
      const userA = await createUserInStoreA({ name: "John" });

      const users = await storeB.queryModel(User);
      const user = users.find((u) => u.id === userA.id);

      assertDefined(user);
      expect(user.name).toBe("John");
    });

    it("converts date fields to Date objects", async () => {
      const testDate = new Date("2024-01-01T00:00:00.000Z");
      const userA = await createUserInStoreA({ testDate });

      const users = await storeB.queryModel(User);
      const user = users.find((u) => u.id === userA.id);

      assertDefined(user);
      expect(user.testDate).toBeInstanceOf(Date);
      expect(user.testDate).toEqual(testDate);
    });

    it("uses identity map - same ID returns same instance", async () => {
      const userA = await createUserInStoreA({ name: "John" });

      const users1 = await storeB.queryModel(User);
      const user1 = users1.find((u) => u.id === userA.id);

      await storeA.transaction(() => {
        userA.name = "John Updated";
      });

      const users2 = await storeB.queryModel(User);
      const user2 = users2.find((u) => u.id === userA.id);

      expect(user1).toBe(user2); // Same instance
      assertDefined(user1);
      expect(user1.name).toBe("John Updated"); // Updated value
    });
  });

  describe("one-to-many relationships (Post ↔ User)", () => {
    // "resolves both directions" merged into EntitySave.test.ts "save() - one-to-one relationships"

    it("returns null when target does not exist", async () => {
      const postId = id();
      const fakeUserId = id();
      await createPostInDbWithDanglingLink(postId, fakeUserId);

      const posts = await storeB.queryModel(Post);
      const post = posts.find((p) => p.id === postId);

      assertDefined(post);
      expect(post.author).toBeNull();
    });

    it("resolves both directions via late hydration", async () => {
      const userId = id();
      const postId = id();
      await createPostInDbWithDanglingLink(postId, userId);

      // Hydrate post first (before user exists)
      const posts = await storeB.queryModel(Post);
      const post = posts.find((p) => p.id === postId);
      assertDefined(post);
      expect(post.author).toBeNull();

      // Create user later
      await storeA.transaction(() => new User("John", userId));

      // Re-hydrate to pick up user
      await storeB.queryAll();
      const user = storeB.getById(User, userId);
      assertDefined(user);

      // Forward: Post.author now resolved
      expect(post.author).toBe(user);
      // Reverse: User.posts contains the post
      expect(user.posts).toContain(post);
    });

    it("late-hydrated child wires into the previously-hydrated parent", async () => {
      const user = await createUserInStoreA({ name: "John" });
      await storeB.queryModel(User);
      const hydratedUser = storeB.getById(User, user.id);
      assertDefined(hydratedUser);
      expect(hydratedUser.posts.length).toBe(0);

      await createPostInStoreA({ author: user });
      await storeB.queryAll();
      expect(hydratedUser.posts.length).toBe(1);
    });

    it("resolves multiple items in collection", async () => {
      const user = await createUserInStoreA({ name: "John" });
      const post1 = await createPostInStoreA({ title: "Post 1", author: user });
      const post2 = await createPostInStoreA({ title: "Post 2", author: user });

      await storeB.queryAll();
      const hydratedUser = storeB.getById(User, user.id);
      const hydratedPost1 = storeB.getById(Post, post1.id);
      const hydratedPost2 = storeB.getById(Post, post2.id);

      assertDefined(hydratedUser);
      assertDefined(hydratedPost1);
      assertDefined(hydratedPost2);
      // Forward: both posts resolve to same user
      expect(hydratedPost1.author).toBe(hydratedUser);
      expect(hydratedPost2.author).toBe(hydratedUser);
      // Reverse: user has both posts
      expect(hydratedUser.posts).toContain(hydratedPost1);
      expect(hydratedUser.posts).toContain(hydratedPost2);
      expect(hydratedUser.posts.length).toBe(2);
    });

    it("does not duplicate on re-hydration", async () => {
      const user = await createUserInStoreA({ name: "John" });
      const post = await createPostInStoreA({ author: user });

      await storeB.queryAll();
      await storeB.queryAll();
      await storeB.queryAll();

      const hydratedUser = storeB.getById(User, user.id);
      const hydratedPost = storeB.getById(Post, post.id);

      assertDefined(hydratedUser);
      expect(hydratedUser.posts.length).toBe(1);
      expect(hydratedUser.posts[0]).toBe(hydratedPost);
    });

  });

  describe("one-to-one relationships (User ↔ Profile)", () => {
    // "resolves both directions" merged into EntitySave.test.ts "save() - one-to-many relationships"

    it("resolves both directions via late hydration", async () => {
      const user = await createUserInStoreA({ name: "John" });
      const profile = await createProfileInStoreA({ bio: "Hello", user });
      await storeA.transaction(() => {
        user.profile = profile;
      });

      // Hydrate Profile FIRST (before User)
      const profiles = await storeB.queryModel(UserProfile);
      const hydratedProfile = profiles.find((p) => p.id === profile.id);
      assertDefined(hydratedProfile);
      expect(hydratedProfile.user).toBeNull();

      // Now hydrate User
      await storeB.queryModel(User);
      const hydratedUser = storeB.getById(User, user.id);
      assertDefined(hydratedUser);

      // Both directions now resolved
      expect(hydratedUser.profile).toBe(hydratedProfile);
      expect(hydratedProfile.user).toBe(hydratedUser);
    });
  });

  describe("nested query hydration", () => {
    /**
     * Tests recursive query expansion and identity map wiring via ID lookup.
     *
     * This test validates two critical behaviors:
     *
     * 1. **Recursive query expansion** (`buildQueryWithRelationships`):
     *    When querying `posts { author { profile } }`, the method recursively expands
     *    User's relationships. The expanded query becomes:
     *    ```
     *    posts {
     *      author {
     *        profile { ... }
     *        posts { $: { fields: ["id"] } }  // Added by recursive expansion
     *        ...other User relationships
     *      }
     *    }
     *    ```
     *
     * 2. **Identity map wiring via ID lookup**:
     *    - post2 is pre-hydrated into identity map via `queryModel(Post)`
     *    - When User is hydrated, it receives `posts: [{ id: post2Id }]` (ID only, no full data)
     *    - The hydrator looks up post2 in the identity map and wires it to `user.posts`
     *    - Without recursive expansion, User wouldn't request posts data, so post2 wouldn't be wired
     */
    it("resolves 3-level deep relationships (Post → User → Profile)", async () => {
      // Create User with Profile
      const user = await createUserInStoreA({ name: "John" });
      const profile = await createProfileInStoreA({ bio: "Hello", user });
      await storeA.transaction(() => {
        user.profile = profile;
      });

      // Create two posts linked to the same User
      const post1 = await createPostInStoreA({ author: user });
      const post2 = await createPostInStoreB({ author: user });

      // Pre-hydrate posts into identity map (post2 will be looked up by ID later)
      await storeB.queryModel(Post);

      // Query 3 levels deep: Post → author (User) → profile (Profile)
      await storeB.query({
        posts: {
          $: { where: { id: post1.id } },
          author: {
            profile: {},
          },
        },
      });

      const hydratedPost1 = storeB.getById(Post, post1.id);
      const hydratedPost2 = storeB.getById(Post, post2.id);
      const hydratedUser = storeB.getById(User, user.id);
      const hydratedProfile = storeB.getById(UserProfile, profile.id);

      // All 3 entity types hydrated
      assertDefined(hydratedPost1);
      assertDefined(hydratedUser);
      assertDefined(hydratedProfile);

      // Forward chain: Post → User → Profile
      expect(hydratedPost1.author).toBe(hydratedUser);
      expect(hydratedUser.profile).toBe(hydratedProfile);
      expect(hydratedProfile.user).toBe(hydratedUser);

      // Identity map wiring: User.posts includes post2 (wired via ID lookup)
      expect(hydratedUser.posts).toContain(hydratedPost1);
      expect(hydratedUser.posts).toContain(hydratedPost2);
      expect(hydratedUser.posts.length).toBe(2);
    });
  });

  describe("reactive subscriptions", () => {
    it("updates identity map and relationships when entity changes in DB", async () => {
      const user = await createUserInStoreA({ name: "John" });
      const post = await createPostInStoreA({ author: user });

      // Set up reactive subscriptions (first callback hydrates from DB)
      await storeA.subscribeModel(User, () => { });
      await storeA.subscribeModel(Post, () => { });

      // Wait for InstantDB eventual consistency
      await waitFor(() => user.posts.includes(post), 3000);

      expect(post.author).toBe(user);
      expect(user.posts).toContain(post);

      // Mark user as deleted directly in DB (simulates another device)
      await db.transact([
        db.__adminDb.tx.users[user.id].update({ deletedAt: new Date().toISOString() }),
      ]);

      // Wait for reactive sync to process
      await waitFor(() => storeA.getById(User, user.id) === undefined, 3000);

      // User removed from identity map
      expect(storeA.getById(User, user.id)).toBeUndefined();

      // Relationship cleaned up
      expect(post.author).toBeNull();
    });
  });
});
