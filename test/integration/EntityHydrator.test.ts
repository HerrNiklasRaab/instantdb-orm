import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import {
  setupTestDatabase,
  id,
  flushMicrotasks,
  type TestInstantDBClient,
} from "../utils/instantdb-test-utils";
import { User } from "../entities/User";
import { Post } from "../entities/Post";
import { Profile } from "../entities/Profile";

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
    const user = new User(entityId);
    storeA.getIdentityMap(User).set(user);
    await flushMicrotasks(); // Wait for tracking to initialize
    user.name = data.name ?? "Test User";
    user.createdAt = data.createdAt ?? new Date();
    user.updatedAt = data.updatedAt ?? new Date();
    await user.save();
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
    const post = new Post(entityId);
    storeA.getIdentityMap(Post).set(post);
    await flushMicrotasks(); // Wait for tracking to initialize
    post.title = data.title ?? "Test Post";
    post.content = data.content;
    post.createdAt = new Date();
    post.updatedAt = new Date();
    if (data.author) {
      post.author = data.author;
    }
    await post.save();
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
    const profile = new Profile(entityId);
    storeA.getIdentityMap(Profile).set(profile);
    await flushMicrotasks();
    profile.bio = data.bio;
    profile.avatarUrl = data.avatarUrl;
    profile.createdAt = new Date();
    profile.updatedAt = new Date();
    if (data.user) {
      profile.user = data.user;
    }
    await profile.save();
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
      const users = await storeB.watchEntity(User);
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
      const users = await storeB.watchEntity(User);
      const user = users.find((u) => u.id === userId);

      expect(user!.createdAt).toBeInstanceOf(Date);
      expect(user!.updatedAt).toBeInstanceOf(Date);
    });

    it("uses identity map - same ID returns same instance", async () => {
      const userId = id();

      // Store A creates user
      await createUserInStoreA(userId, { name: "John" });

      // Store B hydrates first time (only users needed)
      const users1 = await storeB.watchEntity(User);
      const user1 = users1.find((u) => u.id === userId);

      // Store A updates user name
      const userA = storeA.getById(User, userId)!;
      userA.name = "John Updated";
      await userA.save();

      // Store B re-hydrates (only users needed)
      const users2 = await storeB.watchEntity(User);
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
      await storeB.watchAll();
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
      await storeB.watchAll();
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
      const posts = await storeB.watchEntity(Post);
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
      const posts = await storeB.watchEntity(Post);
      const post = posts.find((p) => p.id === postId);
      expect(post!.author).toBeNull();

      // Now Store A creates the user
      await createUserInStoreA(userId, { name: "John" });

      // Store B re-hydrates everything to pick up the new user
      await storeB.watchAll();
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
      await storeB.watchAll();
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
      const posts = await storeB.watchEntity(Post);
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
      await storeB.watchAll();
      await storeB.watchAll();
      await storeB.watchAll();

      const hydratedUser = storeB.getById(User, userId);
      const hydratedPost = storeB.getById(Post, postId);

      expect(hydratedUser!.posts.length).toBe(1);
      expect(hydratedUser!.posts[0]).toBe(hydratedPost);
    });
  });

  describe("deeply nested query hydration", () => {
    it("hydrates 3-level nested relationships with where clause (User → referrals → referrals)", async () => {
      const userId = id();
      const referral1Id = id();
      const referral2Id = id();

      // Create User (the referrer)
      const user = await createUserInStoreA(userId, { name: "Primary User" });

      // Create referral users linked to primary user
      const referral1 = await createUserInStoreA(referral1Id, { name: "Referral 1" });
      referral1.referredBy = user;
      await referral1.save();

      const referral2 = await createUserInStoreA(referral2Id, { name: "Referral 2" });
      referral2.referredBy = user;
      await referral2.save();

      // Store B hydrates using nested query with WHERE clause
      await storeB.query({
        users: {
          $: { where: { id: userId } },
          referrals: {},
        },
      });

      // Get hydrated entities
      const hydratedUser = storeB.getById(User, userId);
      const hydratedReferral1 = storeB.getById(User, referral1Id);
      const hydratedReferral2 = storeB.getById(User, referral2Id);

      // User → referrals
      expect(hydratedUser!.referrals).toContain(hydratedReferral1);
      expect(hydratedUser!.referrals).toContain(hydratedReferral2);
      expect(hydratedUser!.referrals.length).toBe(2);

      // Verify reverse relationships
      expect(hydratedReferral1!.referredBy).toBe(hydratedUser);
      expect(hydratedReferral2!.referredBy).toBe(hydratedUser);
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
      await user.save();

      // Store B hydrates Profile FIRST (before User)
      const profiles = await storeB.watchEntity(Profile);
      const hydratedProfile = profiles.find((p) => p.id === profileId);

      // Profile.user should be null because User hasn't been hydrated yet
      expect(hydratedProfile!.user).toBeNull();

      // Now Store B hydrates User
      await storeB.watchEntity(User);
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
      await user.save();

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
});
