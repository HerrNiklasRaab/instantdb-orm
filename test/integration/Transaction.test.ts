import { describe, it, expect, beforeEach } from "vitest";
import {
  setupTestDatabase,
  type TestInstantDBClient,
} from "../utils/instantdb-test-utils";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { User } from "../entities/User";
import { Post } from "../entities/Post";

describe("Transaction (Integration)", () => {
  let db: TestInstantDBClient;
  let store: RootStore;

  beforeEach(() => {
    db = setupTestDatabase();
    store = new RootStore({ db });
  });

  function createVerificationStore(): RootStore {
    return new RootStore({ db });
  }

  function createUser(name = "Test User"): User {
    return new User(name);
  }

  function createPost(title = "Test Post"): Post {
    return new Post(title);
  }

  describe("store.transaction() - short-lived", () => {
    it("auto-commits on success", async () => {
      const user = createUser("Original");
      await store.save(user);

      await store.transaction(async () => {
        user.name = "Updated";
      });

      const storeB = createVerificationStore();
      await storeB.queryModel(User);
      expect(storeB.getById(User, user.id)?.name).toBe("Updated");
    });

    it("auto-rollback on error", async () => {
      const user = createUser("Original");
      await store.save(user);

      await expect(
        store.transaction(async () => {
          user.name = "Changed";
          throw new Error("Simulated error");
        })
      ).rejects.toThrow("Simulated error");

      expect(user.name).toBe("Original");
    });

    it("commits multiple model changes atomically", async () => {
      const user1 = createUser("User 1");
      const user2 = createUser("User 2");
      await store.save(user1);
      await store.save(user2);

      await store.transaction(async () => {
        user1.name = "Updated User 1";
        user2.name = "Updated User 2";
      });

      const storeB = createVerificationStore();
      await storeB.queryModel(User);
      expect(storeB.getById(User, user1.id)?.name).toBe("Updated User 1");
      expect(storeB.getById(User, user2.id)?.name).toBe("Updated User 2");
    });

    it("resets change trackers after commit", async () => {
      const user = createUser();
      await store.save(user);

      await store.transaction(async () => {
        user.name = "Changed";
        expect(user.isDirty()).toBe(true);
      });

      expect(user.isDirty()).toBe(false);
    });

    it("captures newly constructed models", async () => {
      const user = createUser("Author");
      await store.save(user);

      let postId: string;
      await store.transaction(async () => {
        const post = createPost("New Post");
        post.author = user;
        postId = post.id;
      });

      const storeB = createVerificationStore();
      await storeB.queryModel(Post);
      await storeB.queryModel(User);
      const savedPost = storeB.getById(Post, postId!);
      expect(savedPost?.title).toBe("New Post");
      expect(savedPost?.author?.id).toBe(user.id);
    });

    it("commits with no changes without error", async () => {
      const user = createUser();
      await store.save(user);

      await store.transaction(async () => {
        // no changes
      });

      expect(user.isDirty()).toBe(false);
    });

    it("does not flush mutations made outside of any transaction", async () => {
      // A transaction must persist exactly what it mutated — not earlier
      // out-of-transaction mutations sitting on the model. Otherwise stale
      // state from anywhere (uncommitted user edits, hydration side effects,
      // etc.) leaks into the next save and bloats payloads.
      const user = createUser("Original");
      await store.save(user);

      // Stray mutation outside any transaction.
      user.name = "stray";

      // Real mutation, inside a transaction, on a different field.
      await store.transaction(async () => {
        user.testDate = new Date("2026-06-01T00:00:00.000Z");
      });

      // DB truth via a fresh store: testDate is persisted, name is not.
      const verify = createVerificationStore();
      await verify.queryModel(User);
      const refreshed = verify.getById(User, user.id)!;
      expect(refreshed.testDate?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
      expect(refreshed.name).toBe("Original");
    });
  });

  describe("createTransaction() - long-lived", () => {
    it("commits only claimed models via run()", async () => {
      const user = createUser("Original");
      await store.save(user);

      const tx = store.createTransaction();
      tx.run(() => {
        user.name = "Updated";
      });

      await tx.commit();

      const storeB = createVerificationStore();
      await storeB.queryModel(User);
      expect(storeB.getById(User, user.id)?.name).toBe("Updated");
    });

    it("rollback restores scalar fields", async () => {
      const user = createUser("Original Name");
      await store.save(user);

      const tx = store.createTransaction();
      tx.run(() => {
        user.name = "Changed Name";
      });

      expect(user.name).toBe("Changed Name");
      tx.rollback();
      expect(user.name).toBe("Original Name");
    });

    it("rollback restores multiple scalar fields", async () => {
      const user = createUser("Original");
      const originalDate = user.testDate;
      await store.save(user);

      const tx = store.createTransaction();
      tx.run(() => {
        user.name = "Changed";
        user.testDate = new Date("2024-01-01");
      });

      tx.rollback();

      expect(user.name).toBe("Original");
      expect(user.testDate).toEqual(originalDate);
    });

    it("entity is not dirty after rollback", async () => {
      const user = createUser();
      await store.save(user);

      const tx = store.createTransaction();
      tx.run(() => {
        user.name = "Changed";
      });
      expect(user.isDirty()).toBe(true);

      tx.rollback();
      expect(user.isDirty()).toBe(false);
    });

    it("removes new model from identity map on rollback", async () => {
      const existingUser = createUser("Existing");
      await store.save(existingUser);

      const tx = store.createTransaction();
      let newUser: User;
      tx.run(() => {
        newUser = createUser("New User");
      });

      expect(store.getById(User, newUser!.id)).toBe(newUser!);

      tx.rollback();

      expect(store.getById(User, newUser!.id)).toBeUndefined();
      expect(store.getById(User, existingUser.id)).toBe(existingUser);
    });

    it("restores to-one relationship on rollback (and the reverse side)", async () => {
      const user = createUser();
      const post = createPost();
      await store.save(user);
      post.author = user;
      await store.save(post);

      expect(user.posts).toContain(post);

      let newUser!: User;
      const tx = store.createTransaction();
      tx.run(() => {
        newUser = createUser("New Author");
        post.author = newUser;
      });

      expect(post.author?.name).toBe("New Author");
      // Wirer should have moved the post off `user` and onto `newUser`.
      expect(newUser.posts).toContain(post);
      expect(user.posts).not.toContain(post);

      tx.rollback();

      expect(post.author).toBe(user);
      // Reverse side rolls back too: post is back on `user`, off `newUser`.
      expect(user.posts).toContain(post);
      expect(newUser.posts).not.toContain(post);
    });

    it("restores to-one relationship to null on rollback (and the reverse side)", async () => {
      const user = createUser();
      const post = createPost();
      await store.save(user);
      await store.save(post);

      expect(post.author).toBeNull();
      expect(user.posts).not.toContain(post);

      const tx = store.createTransaction();
      tx.run(() => {
        post.author = user;
      });

      expect(post.author).toBe(user);
      expect(user.posts).toContain(post);

      tx.rollback();

      expect(post.author).toBeNull();
      expect(user.posts).not.toContain(post);
    });

    it("restores to-many relationship on rollback (and the reverse side)", async () => {
      const user = createUser();
      const post1 = createPost("Post 1");
      const post2 = createPost("Post 2");
      await store.save(user);
      await store.save(post1);
      await store.save(post2);

      user.posts.push(post1);
      await store.save(user);

      expect(user.posts).toHaveLength(1);
      expect(post1.author).toBe(user);
      expect(post2.author).toBeNull();

      const tx = store.createTransaction();
      tx.run(() => {
        user.posts.push(post2);
      });

      expect(user.posts).toHaveLength(2);
      expect(post2.author).toBe(user);

      tx.rollback();

      expect(user.posts).toHaveLength(1);
      expect(user.posts[0]).toBe(post1);
      // Reverse side rolls back too: post2's author goes back to null.
      expect(post2.author).toBeNull();
      expect(post1.author).toBe(user);
    });

    it("restores removed items in to-many relationship on rollback (and the reverse side)", async () => {
      const user = createUser();
      const post = createPost();
      await store.save(user);
      await store.save(post);

      user.posts.push(post);
      await store.save(user);

      expect(user.posts).toHaveLength(1);
      expect(post.author).toBe(user);

      const tx = store.createTransaction();
      tx.run(() => {
        user.posts.pop();
      });

      expect(user.posts).toHaveLength(0);
      // Wirer should have cleared post.author when it was popped.
      expect(post.author).toBeNull();

      tx.rollback();

      expect(user.posts).toHaveLength(1);
      expect(user.posts[0]).toBe(post);
      // Reverse side rolls back too: post.author goes back to user.
      expect(post.author).toBe(user);
    });

    it("rollback preserves pre-transaction local dirty state on the wired side", async () => {
      // Synced: user owns post1. post2 exists but is not linked to user.
      const user = createUser("Alice");
      const post1 = createPost("First");
      post1.author = user;
      const post2 = createPost("Second");
      await store.save(user);
      await store.save(post1);
      await store.save(post2);

      // Pre-transaction local edit: link post2 to user via the back-ref
      // array. user is now dirty for posts (+post2).
      user.posts.push(post2);
      expect(user.isDirty()).toBe(true);

      // Inside the transaction, mutate a SIBLING of user. The wirer fires
      // on user.posts (splicing post1 out) which causes the transaction to
      // claim user. Then we abort.
      const tx = store.createTransaction();
      tx.run(() => {
        post1.author = null;
      });
      tx.rollback();

      // Data restoration is fine: post1 back on user, post2 still there.
      expect(user.posts).toContain(post1);
      expect(user.posts).toContain(post2);

      // The pre-transaction local diff (+post2) must survive the rollback.
      // ScopedTransaction.restoreFromSnapshot rehydrates from the claim
      // snapshot and then calls _tracker.reset() — which sets the baseline
      // to the claim-time current state (which already included post2),
      // silently absorbing the pre-transaction diff.
      expect(user.isDirty()).toBe(true);
    });

    it("throws when using a finalized transaction", async () => {
      const tx = store.createTransaction();
      await tx.commit();

      expect(() => tx.run(() => { })).toThrow("Transaction has already been finalized");
      await expect(tx.commit()).rejects.toThrow("Transaction has already been finalized");
      expect(() => tx.rollback()).toThrow("Transaction has already been finalized");
    });
  });

  describe("parallel transactions", () => {
    it("two transactions commit independently", async () => {
      const user = createUser("User");
      const post = createPost("Post");
      await store.save(user);
      await store.save(post);

      const txUser = store.createTransaction();
      const txPost = store.createTransaction();

      txUser.run(() => {
        user.name = "Updated User";
      });

      txPost.run(() => {
        post.title = "Updated Post";
      });

      // Commit only user transaction
      await txUser.commit();

      const storeB = createVerificationStore();
      await storeB.queryModel(User);
      await storeB.queryModel(Post);

      expect(storeB.getById(User, user.id)?.name).toBe("Updated User");
      // Post should NOT be persisted yet
      expect(storeB.getById(Post, post.id)?.title).toBe("Post");

      // Now commit post transaction
      await txPost.commit();

      const storeC = createVerificationStore();
      await storeC.queryModel(Post);
      expect(storeC.getById(Post, post.id)?.title).toBe("Updated Post");
    });

    it("rollback one does not affect the other", async () => {
      const user = createUser("Original User");
      const post = createPost("Original Post");
      await store.save(user);
      await store.save(post);

      const txUser = store.createTransaction();
      const txPost = store.createTransaction();

      txUser.run(() => {
        user.name = "Changed User";
      });

      txPost.run(() => {
        post.title = "Changed Post";
      });

      // Rollback user transaction
      txUser.rollback();

      expect(user.name).toBe("Original User");
      expect(post.title).toBe("Changed Post");

      // Post transaction can still commit
      await txPost.commit();

      const storeB = createVerificationStore();
      await storeB.queryModel(Post);
      expect(storeB.getById(Post, post.id)?.title).toBe("Changed Post");
    });

    it("last write wins when same model is claimed by two transactions", async () => {
      const user = createUser("Original");
      await store.save(user);

      const tx1 = store.createTransaction();
      const tx2 = store.createTransaction();

      tx1.run(() => {
        user.name = "Changed by tx1";
      });

      tx2.run(() => {
        user.name = "Changed by tx2";
      });

      // tx2 commits last — its value wins
      await tx1.commit();
      await tx2.commit();

      const storeB = createVerificationStore();
      await storeB.queryModel(User);
      expect(storeB.getById(User, user.id)?.name).toBe("Changed by tx2");
    });

    it("model can be claimed by new transaction after previous one is finalized", async () => {
      const user = createUser("Original");
      await store.save(user);

      const tx1 = store.createTransaction();
      tx1.run(() => {
        user.name = "First change";
      });
      await tx1.commit();

      const tx2 = store.createTransaction();
      tx2.run(() => {
        user.name = "Second change";
      });
      await tx2.commit();

      const storeB = createVerificationStore();
      await storeB.queryModel(User);
      expect(storeB.getById(User, user.id)?.name).toBe("Second change");
    });

    it("new models created in parallel transactions are isolated", async () => {
      const txUser = store.createTransaction();
      const txPost = store.createTransaction();

      let newUser: User;
      let newPost: Post;

      txUser.run(() => {
        newUser = createUser("New User");
      });

      txPost.run(() => {
        newPost = createPost("New Post");
      });

      // Rollback user transaction
      txUser.rollback();

      expect(store.getById(User, newUser!.id)).toBeUndefined();
      expect(store.getById(Post, newPost!.id)).toBe(newPost!);

      // Post transaction can still commit
      await txPost.commit();

      const storeB = createVerificationStore();
      await storeB.queryModel(Post);
      expect(storeB.getById(Post, newPost!.id)?.title).toBe("New Post");
    });
  });

  describe("error handling", () => {
    it("clears transaction state even if commit fails", async () => {
      const user = createUser();
      await store.save(user);

      const tx = store.createTransaction();
      tx.run(() => {
        user.name = "Changed";
      });

      const originalTransact = store.db.transact.bind(store.db);
      store.db.transact = async () => {
        throw new Error("Simulated DB error");
      };

      try {
        await expect(tx.commit()).rejects.toThrow("Simulated DB error");
      } finally {
        store.db.transact = originalTransact;
      }
    });

    it("save() works independently of transactions", async () => {
      const user = createUser("Original");
      await store.save(user);

      const tx = store.createTransaction();
      tx.run(() => {
        user.name = "In Transaction";
      });

      // Create and save a separate model outside any transaction
      const post = createPost("Independent");
      await store.save(post);

      const storeB = createVerificationStore();
      await storeB.queryModel(Post);
      expect(storeB.getById(Post, post.id)?.title).toBe("Independent");

      tx.rollback();
    });
  });
});
