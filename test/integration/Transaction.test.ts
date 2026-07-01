import { describe, it, expect, beforeEach } from "vitest";
import {
  assertDefined,
  setupTestDatabase,
  type TestInstantDBClient,
} from "./support/instantdb-test-utils";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { Temporal } from "../../src/object-graph";
import type { AppSchema } from "../support/instant.schema";
import { User } from "../support/entities/User";
import { Post } from "../support/entities/Post";
import { Tag } from "../support/entities/Tag";

describe("Transaction (Integration)", () => {
  let db: TestInstantDBClient;
  let store: RootStore<AppSchema>;

  beforeEach(() => {
    db = setupTestDatabase();
    store = new RootStore<AppSchema>({ db });
  });

  function createVerificationStore(): RootStore<AppSchema> {
    return new RootStore<AppSchema>({ db });
  }

  function createUser(name = "Test User"): User {
    return new User(name);
  }

  function createPost(title = "Test Post"): Post {
    return new Post(title);
  }

  function createTag(name = "Test Tag"): Tag {
    return new Tag(name);
  }

  /** Setup helper: persist a freshly-constructed entity through a tx. */
  async function persist<T>(factory: () => T): Promise<T> {
    return store.transaction(factory);
  }

  describe("store.transaction() - short-lived", () => {
    it("auto-commits on success", async () => {
      const user = await persist(() => createUser("Original"));

      await store.transaction(() => {
        user.name = "Updated";
      });

      const storeB = createVerificationStore();
      await storeB.queryModel(User);
      expect(storeB.getById(User, user.id)?.name).toBe("Updated");
    });

    it("auto-rollback on error", async () => {
      const user = await persist(() => createUser("Original"));

      await expect(
        store.transaction(() => {
          user.name = "Changed";
          throw new Error("Simulated error");
        })
      ).rejects.toThrow("Simulated error");

      expect(user.name).toBe("Original");
    });

    it("commits multiple model changes atomically", async () => {
      const user1 = await persist(() => createUser("User 1"));
      const user2 = await persist(() => createUser("User 2"));

      await store.transaction(() => {
        user1.name = "Updated User 1";
        user2.name = "Updated User 2";
      });

      const storeB = createVerificationStore();
      await storeB.queryModel(User);
      expect(storeB.getById(User, user1.id)?.name).toBe("Updated User 1");
      expect(storeB.getById(User, user2.id)?.name).toBe("Updated User 2");
    });

    it("captures newly constructed models", async () => {
      const user = await persist(() => createUser("Author"));

      let postId: string | undefined;
      await store.transaction(() => {
        const post = createPost("New Post");
        post.author = user;
        postId = post.id;
      });

      const storeB = createVerificationStore();
      await storeB.queryModel(Post);
      await storeB.queryModel(User);
      assertDefined(postId);
      const savedPost = storeB.getById(Post, postId);
      expect(savedPost?.title).toBe("New Post");
      expect(savedPost?.author?.id).toBe(user.id);
    });

    it("commits with no changes without error", async () => {
      await persist(() => createUser());

      await store.transaction(() => {
        // no changes
      });
    });

    it("returns the callback's value", async () => {
      const user = await store.transaction(() => new User("From Callback"));
      expect(user).toBeInstanceOf(User);
      expect(user.name).toBe("From Callback");
    });
  });

  describe("createTransaction() - long-lived", () => {
    it("commits only claimed models via run()", async () => {
      const user = await persist(() => createUser("Original"));

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
      const user = await persist(() => createUser("Original Name"));

      const tx = store.createTransaction();
      tx.run(() => {
        user.name = "Changed Name";
      });

      expect(user.name).toBe("Changed Name");
      tx.rollback();
      expect(user.name).toBe("Original Name");
    });

    it("rollback restores multiple scalar fields", async () => {
      const user = await persist(() => createUser("Original"));
      const originalDate = user.testDate;

      const tx = store.createTransaction();
      tx.run(() => {
        user.name = "Changed";
        user.testDate = Temporal.Instant.from("2024-01-01T00:00:00Z");
      });

      tx.rollback();

      expect(user.name).toBe("Original");
      expect(user.testDate).toEqual(originalDate);
    });

    it("removes new model from identity map on rollback", async () => {
      const existingUser = await persist(() => createUser("Existing"));

      const tx = store.createTransaction();
      let newUser: User | undefined;
      tx.run(() => {
        newUser = createUser("New User");
      });

      assertDefined(newUser);
      expect(store.getById(User, newUser.id)).toBe(newUser);

      tx.rollback();

      expect(store.getById(User, newUser.id)).toBeUndefined();
      expect(store.getById(User, existingUser.id)).toBe(existingUser);
    });

    it("restores to-one relationship on rollback (and the reverse side)", async () => {
      const user = await persist(() => createUser());
      const post = await persist(() => {
        const p = createPost();
        p.author = user;
        return p;
      });

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
      const user = await persist(() => createUser());
      const post = await persist(() => createPost());

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
      const user = await persist(() => createUser());
      const post1 = await persist(() => createPost("Post 1"));
      const post2 = await persist(() => createPost("Post 2"));

      await store.transaction(() => {
        user.posts.push(post1);
      });

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
      const user = await persist(() => createUser());
      const post = await persist(() => createPost());

      await store.transaction(() => {
        user.posts.push(post);
      });

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

    it("throws when using a finalized transaction", async () => {
      const tx = store.createTransaction();
      await tx.commit();

      expect(() => { tx.run(() => { }); }).toThrow("Transaction has already been finalized");
      await expect(tx.commit()).rejects.toThrow("Transaction has already been finalized");
      expect(() => { tx.rollback(); }).toThrow("Transaction has already been finalized");
    });
  });

  describe("transient model adoption", () => {
    it("persists a transient model assigned through a to-one relationship", async () => {
      const user = await persist(() => createUser("Author"));
      const post = createPost("Transient Post");

      await store.transaction(() => {
        post.author = user;
      });

      const storeB = createVerificationStore();
      await storeB.queryModel(User);
      await storeB.queryModel(Post);
      const savedPost = storeB.getById(Post, post.id);

      expect(savedPost?.title).toBe("Transient Post");
      expect(savedPost?.author?.id).toBe(user.id);
    });

    it("persists a transient model pushed into a to-many relationship", async () => {
      const user = await persist(() => createUser("Author"));
      const post = createPost("Transient Post");

      await store.transaction(() => {
        user.posts.push(post);
      });

      const storeB = createVerificationStore();
      await storeB.queryModel(User);
      await storeB.queryModel(Post);
      const savedUser = storeB.getById(User, user.id);
      const savedPost = storeB.getById(Post, post.id);

      expect(savedPost?.title).toBe("Transient Post");
      expect(savedPost?.author?.id).toBe(user.id);
      expect(savedUser?.posts.map((p) => p.id)).toContain(post.id);
    });

    it("persists a connected transient graph when one member is attached", async () => {
      const tag = await persist(() => createTag("poker"));
      const author = createUser("Transient Author");
      const post = new Post("Transient Graph Post", author);

      await store.transaction(() => {
        tag.posts.push(post);
      });

      const storeB = createVerificationStore();
      await storeB.queryModel(User);
      await storeB.queryModel(Post);
      await storeB.queryModel(Tag);
      const savedAuthor = storeB.getById(User, author.id);
      const savedPost = storeB.getById(Post, post.id);
      const savedTag = storeB.getById(Tag, tag.id);

      expect(savedAuthor?.name).toBe("Transient Author");
      expect(savedPost?.title).toBe("Transient Graph Post");
      expect(savedPost?.author?.id).toBe(author.id);
      expect(savedPost?.tags.map((saved) => saved.id)).toContain(tag.id);
      expect(savedTag?.posts.map((saved) => saved.id)).toContain(post.id);
    });

    it("restores an adopted transient model on rollback and allows retry", async () => {
      const user = await persist(() => createUser("Author"));
      const post = createPost("Retryable Post");

      const tx = store.createTransaction();
      tx.run(() => {
        post.author = user;
      });

      expect(store.getById(Post, post.id)).toBe(post);
      expect(post.author).toBe(user);

      tx.rollback();

      expect(store.getById(Post, post.id)).toBeUndefined();
      expect(post.author).toBeNull();
      expect(user.posts).not.toContain(post);

      await store.transaction(() => {
        post.author = user;
      });

      const storeB = createVerificationStore();
      await storeB.queryModel(User);
      await storeB.queryModel(Post);
      const savedPost = storeB.getById(Post, post.id);

      expect(savedPost?.title).toBe("Retryable Post");
      expect(savedPost?.author?.id).toBe(user.id);
    });

    it("restores a transaction-created model on rollback and allows retry", async () => {
      const user = await persist(() => createUser("Author"));
      const tx = store.createTransaction();
      let post: Post | undefined;

      tx.run(() => {
        post = createPost("Transaction-Born Post");
      });

      assertDefined(post);
      const retryPost = post;
      expect(store.getById(Post, retryPost.id)).toBe(retryPost);

      tx.rollback();

      expect(store.getById(Post, retryPost.id)).toBeUndefined();

      await store.transaction(() => {
        retryPost.author = user;
      });

      const storeB = createVerificationStore();
      await storeB.queryModel(User);
      await storeB.queryModel(Post);
      const savedPost = storeB.getById(Post, retryPost.id);

      expect(savedPost?.title).toBe("Transaction-Born Post");
      expect(savedPost?.author?.id).toBe(user.id);
    });

    it("throws for scalar-only mutation of a transient model and does not persist it", async () => {
      const post = createPost("Transient Post");
      let error: unknown = null;

      try {
        await store.transaction(() => {
          post.title = "Changed Without Relationship";
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);

      const storeB = createVerificationStore();
      await storeB.queryModel(Post);
      expect(storeB.getById(Post, post.id)).toBeUndefined();
    });
  });

  describe("parallel transactions", () => {
    it("two transactions commit independently", async () => {
      const user = await persist(() => createUser("User"));
      const post = await persist(() => createPost("Post"));

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
      const user = await persist(() => createUser("Original User"));
      const post = await persist(() => createPost("Original Post"));

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
      const user = await persist(() => createUser("Original"));

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
      const user = await persist(() => createUser("Original"));

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

      let newUser: User | undefined;
      let newPost: Post | undefined;

      txUser.run(() => {
        newUser = createUser("New User");
      });

      txPost.run(() => {
        newPost = createPost("New Post");
      });

      // Rollback user transaction
      txUser.rollback();

      assertDefined(newUser);
      assertDefined(newPost);
      expect(store.getById(User, newUser.id)).toBeUndefined();
      expect(store.getById(Post, newPost.id)).toBe(newPost);

      // Post transaction can still commit
      await txPost.commit();

      const storeB = createVerificationStore();
      await storeB.queryModel(Post);
      expect(storeB.getById(Post, newPost.id)?.title).toBe("New Post");
    });
  });

  describe("error handling", () => {
    it("clears transaction state even if commit fails", async () => {
      const user = await persist(() => createUser());

      const tx = store.createTransaction();
      tx.run(() => {
        user.name = "Changed";
      });

      const originalTransact = store.db.transact.bind(store.db);
      store.db.transact = () =>
        Promise.reject(new Error("Simulated DB error"));

      try {
        await expect(tx.commit()).rejects.toThrow("Simulated DB error");
      } finally {
        store.db.transact = originalTransact;
      }
    });

    it("a short-lived transaction can run alongside an open long-lived one", async () => {
      const user = await persist(() => createUser("Original"));

      const tx = store.createTransaction();
      tx.run(() => {
        user.name = "In Transaction";
      });

      // Run a separate short-lived tx outside the long-lived one.
      const post = await store.transaction(() => createPost("Independent"));

      const storeB = createVerificationStore();
      await storeB.queryModel(Post);
      expect(storeB.getById(Post, post.id)?.title).toBe("Independent");

      tx.rollback();
    });
  });

  describe("tx-only enforcement", () => {
    it("throws when a tracked model is mutated outside of any transaction", async () => {
      const user = await persist(() => createUser("Original"));

      expect(() => {
        user.name = "stray";
      }).toThrow(/transaction/i);
    });
  });
});
