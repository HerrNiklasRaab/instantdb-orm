import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import {
  setupTestDatabase,
  id,
  type TestInstantDBClient,
} from "../utils/instantdb-test-utils";
import { User } from "../entities/User";
import { Post } from "../entities/Post";
import { Profile } from "../entities/Profile";
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
    entityId: string,
    data: Partial<{
      name: string;
      createdAt: Date;
      updatedAt: Date;
    }>
  ): Promise<User> {
    const user = new User(entityId, {
      name: data.name ?? "Test User",
      createdAt: data.createdAt ?? new Date(),
      updatedAt: data.updatedAt ?? new Date(),
    });
    await storeA.save(user);
    return user;
  }

  // Helper to create post through Store A
  async function createPostInStoreA(
    entityId: string,
    data: Partial<{
      title: string;
      content: string;
      author: User;
    }>
  ): Promise<Post> {
    const post = new Post(entityId, {
      title: data.title ?? "Test Post",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    post.content = data.content;
    if (data.author) {
      post.author = data.author;
    }
    await storeA.save(post);
    return post;
  }

  // Helper to create post through Store A
  async function createPostInStoreB(
    entityId: string,
    data: Partial<{
      title: string;
      content: string;
      author: User;
    }>
  ): Promise<Post> {
    const post = new Post(entityId, {
      title: data.title ?? "Test Post",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    post.content = data.content;
    if (data.author) {
      post.author = data.author;
    }
    await storeB.save(post);
    return post;
  }

  // Helper to create profile through Store A
  async function createProfileInStoreA(
    entityId: string,
    data: Partial<{
      bio: string;
      avatarUrl: string;
      user: User;
    }>
  ): Promise<Profile> {
    const profile = new Profile(entityId, { createdAt: new Date(), updatedAt: new Date() });
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
      const userId = id();

      // Store A creates user
      await createUserInStoreA(userId, {
        name: "John",
      });

      // Store B hydrates and verifies (only users needed)
      const users = await storeB.queryModel(User);
      const user = users.find((u) => u.id === userId);

      expect(user).toBeDefined();
      expect(user!.name).toBe("John");
    });

    it("converts date fields to Date objects", async () => {
      const userId = id();
      const testDate = new Date("2024-01-01T00:00:00.000Z");

      // Store A creates user with specific dates
      await createUserInStoreA(userId, {
        createdAt: testDate,
        updatedAt: testDate,
      });

      // Store B hydrates and verifies dates are Date objects (only users needed)
      const users = await storeB.queryModel(User);
      const user = users.find((u) => u.id === userId);

      expect(user!.createdAt).toBeInstanceOf(Date);
      expect(user!.updatedAt).toBeInstanceOf(Date);
    });

    it("uses identity map - same ID returns same instance", async () => {
      const userId = id();

      // Store A creates user
      const userA = await createUserInStoreA(userId, { name: "John" });

      // Store B hydrates first time (only users needed)
      const users1 = await storeB.queryModel(User);
      const user1 = users1.find((u) => u.id === userId);

      // Store A updates user name
      userA.name = "John Updated";
      await storeA.save(userA);

      // Store B re-hydrates (only users needed)
      const users2 = await storeB.queryModel(User);
      const user2 = users2.find((u) => u.id === userId);

      expect(user1).toBe(user2); // Same instance
      expect(user1!.name).toBe("John Updated"); // Updated value
    });
  });

  describe("forward link resolution", () => {
    it("sets forward relationship when target exists", async () => {
      const userId = id();
      const postId = id();

      // Store A creates user and post with relationship
      const user = await createUserInStoreA(userId, { name: "John" });
      await createPostInStoreA(postId, { author: user });

      // Store B hydrates and verifies relationship
      await storeB.queryAll();
      const hydratedUser = storeB.getById(User, userId);
      const hydratedPost = storeB.getById(Post, postId);

      expect(hydratedPost!.author).toBe(hydratedUser);
    });

    it("sets reverse relationship on target (has many)", async () => {
      const userId = id();
      const postId = id();

      // Store A creates user and post with relationship
      const user = await createUserInStoreA(userId, { name: "John" });
      await createPostInStoreA(postId, { author: user });

      // Store B hydrates and verifies reverse relationship
      await storeB.queryAll();
      const hydratedUser = storeB.getById(User, userId);
      const hydratedPost = storeB.getById(Post, postId);

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

      // Now Store A creates the user
      await createUserInStoreA(userId, { name: "John" });

      // Store B re-hydrates everything to pick up the new user
      await storeB.queryAll();
      const user = storeB.getById(User, userId);

      // Post's author should now be resolved
      expect(post!.author).toBe(user);
      expect(user!.posts).toContain(post);
    });

    it("handles multiple forward entities referencing same target", async () => {
      const userId = id();
      const postId1 = id();
      const postId2 = id();

      // Store A creates user and two posts linked to it
      const user = await createUserInStoreA(userId, { name: "John" });
      await createPostInStoreA(postId1, { title: "Post 1", author: user });
      await createPostInStoreA(postId2, { title: "Post 2", author: user });

      // Store B hydrates and verifies all relationships
      await storeB.queryAll();
      const hydratedUser = storeB.getById(User, userId);
      const post1 = storeB.getById(Post, postId1);
      const post2 = storeB.getById(Post, postId2);

      expect(post1!.author).toBe(hydratedUser);
      expect(post2!.author).toBe(hydratedUser);
      expect(hydratedUser!.posts).toContain(post1);
      expect(hydratedUser!.posts).toContain(post2);
      expect(hydratedUser!.posts.length).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("does not set relationship when no link exists", async () => {
      const postId = id();

      // Store A creates post without author link
      await createPostInStoreA(postId, {});

      // Store B hydrates and verifies no relationship (only posts needed)
      const posts = await storeB.queryModel(Post);
      const post = posts.find((p) => p.id === postId);

      expect(post!.author).toBeNull();
    });

    it("does not duplicate relationships when entity is hydrated multiple times", async () => {
      const userId = id();
      const postId = id();

      // Store A creates user and post with relationship
      const user = await createUserInStoreA(userId, { name: "John" });
      await createPostInStoreA(postId, { author: user });

      // Store B hydrates multiple times
      await storeB.queryAll();
      await storeB.queryAll();
      await storeB.queryAll();

      const hydratedUser = storeB.getById(User, userId);
      const hydratedPost = storeB.getById(Post, postId);

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
      const userId = id();
      const profileId = id();
      const postId = id();
      const postId2 = id();

      // Create User with Profile
      const user = await createUserInStoreA(userId, { name: "John" });
      const profile = await createProfileInStoreA(profileId, { bio: "Hello", user });
      user.profile = profile;
      await storeA.save(user);

      // Create two posts linked to the same User
      await createPostInStoreA(postId, { author: user });
      await createPostInStoreB(postId2, { author: user });

      // Pre-hydrate posts into identity map (post2 will be looked up by ID later)
      await storeB.queryModel(Post);

      // Query 3 levels deep: Post → author (User) → profile (Profile)
      // The recursive expansion adds { posts: { $: { fields: ["id"] } } } to User,
      // which returns posts: [{ id: postId }, { id: post2Id }] (IDs only for circular refs)
      await storeB.query({
        posts: {
          $: { where: { id: postId } },
          author: {
            profile: {},
          },
        },
      });

      const hydratedPost = storeB.getById(Post, postId);
      const hydratedPost2 = storeB.getById(Post, postId2);
      const hydratedUser = storeB.getById(User, userId);
      const hydratedProfile = storeB.getById(Profile, profileId);

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
      const userId = id();
      const profileId = id();

      // Store A creates both User and Profile with relationship
      const user = await createUserInStoreA(userId, { name: "John" });
      const profile = await createProfileInStoreA(profileId, {
        bio: "Hello",
        user: user,
      });
      user.profile = profile;
      await storeA.save(user);

      // Store B hydrates Profile FIRST (before User)
      const profiles = await storeB.queryModel(Profile);
      const hydratedProfile = profiles.find((p) => p.id === profileId);

      // Profile.user should be null because User hasn't been hydrated yet
      expect(hydratedProfile!.user).toBeNull();

      // Now Store B hydrates User
      await storeB.queryModel(User);
      const hydratedUser = storeB.getById(User, userId);

      // Bidirectional wiring should have set both directions
      expect(hydratedUser!.profile).toBe(hydratedProfile);
      expect(hydratedProfile!.user).toBe(hydratedUser);
    });

    it("hydrates one-to-one relationships (User ↔ Profile)", async () => {
      const userId = id();
      const profileId = id();

      // Create User
      const user = await createUserInStoreA(userId, { name: "John" });

      // Create Profile linked to User
      const profile = await createProfileInStoreA(profileId, {
        bio: "Hello world",
        user: user,
      });
      user.profile = profile;
      await storeA.save(user);

      // Store B hydrates
      await storeB.query({
        users: {
          $: { where: { id: userId } },
          profile: {},
        },
      });

      const hydratedUser = storeB.getById(User, userId);
      const hydratedProfile = storeB.getById(Profile, profileId);

      // Verify bidirectional one-to-one
      expect(hydratedUser!.profile).toBe(hydratedProfile);
      expect(hydratedProfile!.user).toBe(hydratedUser);
    });
  });

  describe("constructor order independence", () => {
    it("hydrates correctly regardless of schema field order", async () => {
      const userId = id();
      const testDate = new Date("2024-06-15T10:30:00.000Z");

      // Create user directly in DB with fields in arbitrary order
      await db.transact([
        db.tx.users[userId].update({
          // Note: order here doesn't matter because it's an object
          updatedAt: testDate.toISOString(),
          name: "Order Test User",
          createdAt: testDate.toISOString(),
        }),
      ]);

      // Store B hydrates the user
      const users = await storeB.queryModel(User);
      const user = users.find((u) => u.id === userId);

      // Verify all fields are correctly hydrated
      expect(user).toBeDefined();
      expect(user!.name).toBe("Order Test User");
      expect(user!.createdAt).toEqual(testDate);
      expect(user!.updatedAt).toEqual(testDate);
    });

    it("user-created entities work with any property order in data object", () => {
      const userId = id();
      const now = new Date();

      // Create with properties in different order than schema
      const user1 = new User(userId, { updatedAt: now, name: "User1", createdAt: now });
      const user2 = new User(id(), { createdAt: now, updatedAt: now, name: "User2" });
      const user3 = new User(id(), { name: "User3", createdAt: now, updatedAt: now });

      // All should work correctly
      expect(user1.name).toBe("User1");
      expect(user2.name).toBe("User2");
      expect(user3.name).toBe("User3");
    });
  });
});
