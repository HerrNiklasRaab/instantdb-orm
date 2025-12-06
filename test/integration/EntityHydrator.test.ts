import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import {
  setupTestDatabase,
  id,
  type TestInstantDBClient,
} from "../utils/instantdb-test-utils";
import { User } from "../entities/User";
import { Post } from "../entities/Post";
import { UserProfile } from "../entities/Profile";
// Import MTI entities to register them with model registry
import "../entities/ChessMatch";
import "../entities/SkiMatch";

describe("RootStore hydration (Integration)", () => {
  let db: TestInstantDBClient;
  let storeA: RootStore; // "Device A" - creates data
  let storeB: RootStore; // "Device B" - hydrates data

  beforeEach(() => {
    db = setupTestDatabase();
    storeA = new RootStore({ db });
    storeB = new RootStore({ db });
  });

  // Helper to create user through Store A (simulates another device creating data)
  async function createUserInStoreA(
    data: Partial<{
      name: string;
      testDate: Date;
    }> = {}
  ): Promise<User> {
    const user = new User(data.name ?? "Test User");
    if (data.testDate) {
      user.testDate = data.testDate;
    }
    await storeA.save(user);
    return user;
  }

  // Helper to create post through Store A
  async function createPostInStoreA(
    data: Partial<{
      title: string;
      content: string;
      author: User;
    }> = {}
  ): Promise<Post> {
    const post = new Post(data.title ?? "Test Post");
    post.content = data.content;
    if (data.author) {
      post.author = data.author;
    }
    await storeA.save(post);
    return post;
  }

  // Helper to create post through Store B
  async function createPostInStoreB(
    data: Partial<{
      title: string;
      content: string;
      author: User;
    }> = {}
  ): Promise<Post> {
    const post = new Post(data.title ?? "Test Post");
    post.content = data.content;
    if (data.author) {
      post.author = data.author;
    }
    await storeB.save(post);
    return post;
  }

  // Helper to create profile through Store A
  async function createProfileInStoreA(
    data: Partial<{
      bio: string;
      avatarUrl: string;
      user: User;
    }> = {}
  ): Promise<UserProfile> {
    const profile = new UserProfile();
    profile.bio = data.bio;
    profile.avatarUrl = data.avatarUrl;
    if (data.user) {
      profile.user = data.user;
    }
    await storeA.save(profile);
    return profile;
  }

  // Helper to create post with dangling link directly in DB (for edge case tests)
  async function createPostInDbWithDanglingLink(
    entityId: string,
    fakeUserId: string
  ) {
    await db.transact([
      db.tx.posts[entityId]
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
      // Store A creates user
      const userA = await createUserInStoreA({ name: "John" });

      // Store B hydrates and verifies (only users needed)
      const users = await storeB.queryModel(User);
      const user = users.find((u) => u.id === userA.id);

      expect(user).toBeDefined();
      expect(user!.name).toBe("John");
    });

    it("converts date fields to Date objects", async () => {
      const testDate = new Date("2024-01-01T00:00:00.000Z");

      // Store A creates user with specific testDate
      const userA = await createUserInStoreA({
        testDate: testDate,
      });

      // Store B hydrates and verifies dates are Date objects (only users needed)
      const users = await storeB.queryModel(User);
      const user = users.find((u) => u.id === userA.id);

      expect(user!.testDate).toBeInstanceOf(Date);
      expect(user!.testDate).toEqual(testDate);
    });

    it("uses identity map - same ID returns same instance", async () => {
      // Store A creates user
      const userA = await createUserInStoreA({ name: "John" });

      // Store B hydrates first time (only users needed)
      const users1 = await storeB.queryModel(User);
      const user1 = users1.find((u) => u.id === userA.id);

      // Store A updates user name
      userA.name = "John Updated";
      await storeA.save(userA);

      // Store B re-hydrates (only users needed)
      const users2 = await storeB.queryModel(User);
      const user2 = users2.find((u) => u.id === userA.id);

      expect(user1).toBe(user2); // Same instance
      expect(user1!.name).toBe("John Updated"); // Updated value
    });
  });

  describe("forward link resolution", () => {
    it("sets forward relationship when target exists", async () => {
      // Store A creates user and post with relationship
      const user = await createUserInStoreA({ name: "John" });
      const postA = await createPostInStoreA({ author: user });

      // Store B hydrates and verifies relationship
      await storeB.queryAll();
      const hydratedUser = storeB.getById(User, user.id);
      const hydratedPost = storeB.getById(Post, postA.id);

      expect(hydratedPost!.author).toBe(hydratedUser);
    });

    it("sets reverse relationship on target (has many)", async () => {
      // Store A creates user and post with relationship
      const user = await createUserInStoreA({ name: "John" });
      const postA = await createPostInStoreA({ author: user });

      // Store B hydrates and verifies reverse relationship
      await storeB.queryAll();
      const hydratedUser = storeB.getById(User, user.id);
      const hydratedPost = storeB.getById(Post, postA.id);

      expect(hydratedUser!.posts).toContain(hydratedPost);
      expect(hydratedUser!.posts.length).toBe(1);
    });

    it("forward relationship is null when target does not exist yet", async () => {
      const postId = id();
      const fakeUserId = id();

      // Create post with link to non-existent user directly in DB
      // (simulates corrupted data or data from another system)
      await createPostInDbWithDanglingLink(postId, fakeUserId);

      // Store B hydrates - should handle dangling reference gracefully (only posts needed)
      const posts = await storeB.queryModel(Post);
      const post = posts.find((p) => p.id === postId);

      expect(post!.author).toBeNull();
    });
  });

  describe("reverse link resolution", () => {
    it("updates existing forward entities when target is hydrated later", async () => {
      const userId = id();
      const postId = id();

      // Create post with link to user that doesn't exist yet (direct DB)
      await createPostInDbWithDanglingLink(postId, userId);

      // Store B hydrates post first (before user exists) - only posts needed
      const posts = await storeB.queryModel(Post);
      const post = posts.find((p) => p.id === postId);
      expect(post!.author).toBeNull();

      // Now Store A creates the user with specific ID to match dangling link
      const userA = new User("John", userId);
      await storeA.save(userA);

      // Store B re-hydrates everything to pick up the new user
      await storeB.queryAll();
      const user = storeB.getById(User, userId);

      // Post's author should now be resolved
      expect(post!.author).toBe(user);
      expect(user!.posts).toContain(post);
    });

    it("handles multiple forward entities referencing same target", async () => {
      // Store A creates user and two posts linked to it
      const user = await createUserInStoreA({ name: "John" });
      const post1A = await createPostInStoreA({ title: "Post 1", author: user });
      const post2A = await createPostInStoreA({ title: "Post 2", author: user });

      // Store B hydrates and verifies all relationships
      await storeB.queryAll();
      const hydratedUser = storeB.getById(User, user.id);
      const post1 = storeB.getById(Post, post1A.id);
      const post2 = storeB.getById(Post, post2A.id);

      expect(post1!.author).toBe(hydratedUser);
      expect(post2!.author).toBe(hydratedUser);
      expect(hydratedUser!.posts).toContain(post1);
      expect(hydratedUser!.posts).toContain(post2);
      expect(hydratedUser!.posts.length).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("does not set relationship when no link exists", async () => {
      // Store A creates post without author link
      const postA = await createPostInStoreA({});

      // Store B hydrates and verifies no relationship (only posts needed)
      const posts = await storeB.queryModel(Post);
      const post = posts.find((p) => p.id === postA.id);

      expect(post!.author).toBeNull();
    });

    it("does not duplicate relationships when entity is hydrated multiple times", async () => {
      // Store A creates user and post with relationship
      const user = await createUserInStoreA({ name: "John" });
      const postA = await createPostInStoreA({ author: user });

      // Store B hydrates multiple times
      await storeB.queryAll();
      await storeB.queryAll();
      await storeB.queryAll();

      const hydratedUser = storeB.getById(User, user.id);
      const hydratedPost = storeB.getById(Post, postA.id);

      expect(hydratedUser!.posts.length).toBe(1);
      expect(hydratedUser!.posts[0]).toBe(hydratedPost);
    });
  });

  describe("deeply nested query hydration", () => {
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
    it("hydrates 3-level nested relationships with 3 different entities (Post → User → Profile)", async () => {
      // Create User with Profile
      const user = await createUserInStoreA({ name: "John" });
      const profile = await createProfileInStoreA({ bio: "Hello", user });
      user.profile = profile;
      await storeA.save(user);

      // Create two posts linked to the same User
      const post1A = await createPostInStoreA({ author: user });
      const post2A = await createPostInStoreB({ author: user });

      // Pre-hydrate posts into identity map (post2 will be looked up by ID later)
      await storeB.queryModel(Post);

      // Query 3 levels deep: Post → author (User) → profile (Profile)
      // The recursive expansion adds { posts: { $: { fields: ["id"] } } } to User,
      // which returns posts: [{ id: postId }, { id: post2Id }] (IDs only for circular refs)
      await storeB.query({
        posts: {
          $: { where: { id: post1A.id } },
          author: {
            profile: {},
          },
        },
      });

      const hydratedPost = storeB.getById(Post, post1A.id);
      const hydratedPost2 = storeB.getById(Post, post2A.id);
      const hydratedUser = storeB.getById(User, user.id);
      const hydratedProfile = storeB.getById(UserProfile, profile.id);

      // Verify all 3 entity types hydrated
      expect(hydratedPost).toBeDefined();
      expect(hydratedUser).toBeDefined();
      expect(hydratedProfile).toBeDefined();

      // Verify forward relationships from query: Post → User → Profile
      expect(hydratedPost!.author).toBe(hydratedUser);
      expect(hydratedUser!.profile).toBe(hydratedProfile);
      expect(hydratedProfile!.user).toBe(hydratedUser);

      // Verify identity map wiring: User.posts includes post2 (wired via ID lookup)
      // post2 was NOT in the query, but was pre-hydrated and wired via ID lookup
      expect(hydratedUser!.posts).toContain(hydratedPost);
      expect(hydratedUser!.posts).toContain(hydratedPost2);
      expect(hydratedUser!.posts.length).toBe(2);
    });

    it("resolves one-to-one when Profile synced before User", async () => {
      // Store A creates both User and Profile with relationship
      const user = await createUserInStoreA({ name: "John" });
      const profile = await createProfileInStoreA({
        bio: "Hello",
        user: user,
      });
      user.profile = profile;
      await storeA.save(user);

      // Store B hydrates UserProfile FIRST (before User)
      const profiles = await storeB.queryModel(UserProfile);
      const hydratedProfile = profiles.find((p) => p.id === profile.id);

      // Profile.user should be null because User hasn't been hydrated yet
      expect(hydratedProfile!.user).toBeNull();

      // Now Store B hydrates User
      await storeB.queryModel(User);
      const hydratedUser = storeB.getById(User, user.id);

      // Bidirectional wiring should have set both directions
      expect(hydratedUser!.profile).toBe(hydratedProfile);
      expect(hydratedProfile!.user).toBe(hydratedUser);
    });

    it("hydrates one-to-one relationships (User ↔ Profile)", async () => {
      // Create User
      const user = await createUserInStoreA({ name: "John" });

      // Create Profile linked to User
      const profile = await createProfileInStoreA({
        bio: "Hello world",
        user: user,
      });
      user.profile = profile;
      await storeA.save(user);

      // Store B hydrates
      await storeB.query({
        users: {
          $: { where: { id: user.id } },
          profile: {},
        },
      });

      const hydratedUser = storeB.getById(User, user.id);
      const hydratedProfile = storeB.getById(UserProfile, profile.id);

      // Verify bidirectional one-to-one
      expect(hydratedUser!.profile).toBe(hydratedProfile);
      expect(hydratedProfile!.user).toBe(hydratedUser);
    });
  });

  describe("constructor order independence", () => {
    it("hydrates correctly regardless of schema field order", async () => {
      const userId = id();
      const testDate = new Date("2024-06-15T10:30:00.000Z");
      const now = new Date();

      // Create user directly in DB with fields in arbitrary order
      await db.transact([
        db.tx.users[userId].update({
          // Note: order here doesn't matter because it's an object
          testDate: testDate.toISOString(),
          name: "Order Test User",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }),
      ]);

      // Store B hydrates the user
      const users = await storeB.queryModel(User);
      const user = users.find((u) => u.id === userId);

      // Verify all fields are correctly hydrated
      expect(user).toBeDefined();
      expect(user!.name).toBe("Order Test User");
      expect(user!.testDate).toEqual(testDate);
    });
  });
});
