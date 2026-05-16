import { describe, it, expect, beforeEach } from "vitest";
import {
  setupTestDatabase,
  type TestInstantDBClient,
} from "../utils/instantdb-test-utils";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { User } from "../entities/User";
import { Post } from "../entities/Post";
import { Tag } from "../entities/Tag";

/**
 * Field-level optimistic merge — the "Linear contract".
 *
 * Maps onto Linear vocabulary as:
 *   Post  ↔ Issue
 *   title ↔ issue title
 *   content ↔ issue description
 *   author ↔ assignee
 *   Tag   ↔ Label
 *   tags  ↔ labels on the issue
 *
 * Mental model:
 *   - You open a tx and edit one or two fields on an issue.
 *   - In parallel, a teammate (a *remote* client) changes other fields.
 *   - Mid-tx the wire pushes the teammate's changes to your store via the
 *     hydrator (here we simulate this with `store.queryModel(...)` inside
 *     the tx — same hydrator code path as a subscription delivery).
 *   - Your edits should never be silently overwritten. Untouched fields
 *     on the same issue should still show the live teammate updates.
 *   - On commit, only fields you actually touched go to the DB.
 *   - On rollback, only fields you actually touched are reverted —
 *     teammate updates that arrived mid-tx stay.
 *
 * Architecture this pins ("Option A"):
 *
 *   Each (tx, model) claim carries TWO things:
 *     - claim.data: ModelSnapshot captured at first touch (rollback target)
 *     - touched:    Set<string> populated by the interceptor on every
 *                   user-driven write
 *
 *   The interceptor (`Model.claimForCurrentTransaction`) records the
 *   field name into `touched` only when the write is NOT inside the
 *   hydration or wiring guards — so hydrator/wirer writes never appear
 *   as user intent.
 *
 *   Three decisions, one source of truth (the touched set):
 *     - Commit:        emit chunks for fields in touched, current values.
 *     - Rollback:      restore fields in touched to claim.data values.
 *     - Hydrator skip: skip writes to fields in touched; apply the rest.
 *
 *   claim.data alone (without touched) isn't enough: a claim-vs-current
 *   diff over-reverts on rollback and launders hydrator writes through
 *   the user's commit. The touched set is what makes "user intent"
 *   first-class.
 *
 * These tests currently fail (or pass for the wrong reason — the
 * hydrator stomps your edits) because the field-level decisions above
 * aren't implemented yet. Flip `describe.skip` → `describe` when ready.
 */
describe("Linear-style optimistic merge", () => {
  let db: TestInstantDBClient;
  let store: RootStore;

  beforeEach(() => {
    db = setupTestDatabase();
    store = new RootStore({ db });
  });

  function freshStore(): RootStore {
    return new RootStore({ db });
  }

  /**
   * Apply a change "from another client" by committing through a separate
   * RootStore against the same DB. After this returns, the DB has the
   * remote change; the user's `store` won't see it until it next hydrates.
   */
  async function applyRemote(fn: (remote: RootStore) => void | Promise<void>): Promise<void> {
    const remote = new RootStore({ db });
    await remote.queryAll();
    await remote.transaction(async () => {
      await fn(remote);
    });
  }

  // ---------------------------------------------------------------------------
  // Disjoint fields merge
  // ---------------------------------------------------------------------------
  it("user edits title, teammate reassigns — both survive", async () => {
    const alice = await store.transaction(() => new User("Alice"));
    const bob = await store.transaction(() => new User("Bob"));
    const issue = await store.transaction(() => {
      const p = new Post("Fix bug");
      p.author = alice;
      return p;
    });

    await store.transaction(async () => {
      issue.title = "Fix login bug";

      await applyRemote(async (remote) => {
        const remoteIssue = remote.getById(Post, issue.id)!;
        const remoteBob = remote.getById(User, bob.id)!;
        remoteIssue.author = remoteBob;
      });

      // Subscription / re-query delivers the teammate's change.
      await store.queryModel(Post);

      // Mid-tx view: your edit is intact, teammate's assignee change visible.
      expect(issue.title).toBe("Fix login bug");
      expect(issue.author?.id).toBe(bob.id);
    });

    const verify = freshStore();
    await verify.queryAll();
    const stored = verify.getById(Post, issue.id)!;
    expect(stored.title).toBe("Fix login bug");
    expect(stored.author?.id).toBe(bob.id);
  });

  // ---------------------------------------------------------------------------
  // Same-field conflict, you win
  // ---------------------------------------------------------------------------
  it("same-field conflict on title — user's edit wins", async () => {
    const issue = await store.transaction(() => new Post("Fix bug"));

    await store.transaction(async () => {
      issue.title = "Fix login bug";

      await applyRemote(async (remote) => {
        const remoteIssue = remote.getById(Post, issue.id)!;
        remoteIssue.title = "Resolved by Alice";
      });

      await store.queryModel(Post);

      // Your edit is preserved locally even though DB had "Resolved by Alice".
      expect(issue.title).toBe("Fix login bug");
    });

    const verify = freshStore();
    await verify.queryAll();
    expect(verify.getById(Post, issue.id)!.title).toBe("Fix login bug");
  });

  // ---------------------------------------------------------------------------
  // To-many additive merge (labels)
  // ---------------------------------------------------------------------------
  it("user adds 'frontend' label, teammate adds 'P0' — both end up on issue", async () => {
    const bugLabel = await store.transaction(() => new Tag("bug"));
    const frontendLabel = await store.transaction(() => new Tag("frontend"));
    const p0Label = await store.transaction(() => new Tag("P0"));
    const issue = await store.transaction(() => {
      const p = new Post("Fix bug");
      p.tags.push(bugLabel);
      return p;
    });

    await store.transaction(async () => {
      issue.tags.push(frontendLabel);

      await applyRemote(async (remote) => {
        const remoteIssue = remote.getById(Post, issue.id)!;
        const remoteP0 = remote.getById(Tag, p0Label.id)!;
        remoteIssue.tags.push(remoteP0);
      });

      await store.queryModel(Post);

      // User keeps their local addition; tx will commit it.
      expect(issue.tags.map((t) => t.name)).toContain("frontend");
    });

    const verify = freshStore();
    await verify.queryAll();
    const labelNames = verify
      .getById(Post, issue.id)!
      .tags.map((t) => t.name)
      .sort();
    expect(labelNames).toEqual(["P0", "bug", "frontend"]);
  });

  // ---------------------------------------------------------------------------
  // To-many same-item added on both sides — dedupes
  // ---------------------------------------------------------------------------
  it("user and teammate both add the same label — issue ends with one entry, not two", async () => {
    const bugLabel = await store.transaction(() => new Tag("bug"));
    const p0Label = await store.transaction(() => new Tag("P0"));
    const issue = await store.transaction(() => {
      const p = new Post("Fix bug");
      p.tags.push(bugLabel);
      return p;
    });

    await store.transaction(async () => {
      issue.tags.push(p0Label);

      await applyRemote(async (remote) => {
        const remoteIssue = remote.getById(Post, issue.id)!;
        const remoteP0 = remote.getById(Tag, p0Label.id)!;
        remoteIssue.tags.push(remoteP0);
      });

      await store.queryModel(Post);
    });

    const verify = freshStore();
    await verify.queryAll();
    const labelNames = verify
      .getById(Post, issue.id)!
      .tags.map((t) => t.name)
      .sort();
    expect(labelNames).toEqual(["P0", "bug"]);
  });

  // ---------------------------------------------------------------------------
  // To-many removal preserved across remote add
  // ---------------------------------------------------------------------------
  it("user removes 'frontend', teammate adds 'P0' — issue ends with bug + P0", async () => {
    const bugLabel = await store.transaction(() => new Tag("bug"));
    const frontendLabel = await store.transaction(() => new Tag("frontend"));
    const p0Label = await store.transaction(() => new Tag("P0"));
    const issue = await store.transaction(() => {
      const p = new Post("Fix bug");
      p.tags.push(bugLabel);
      p.tags.push(frontendLabel);
      return p;
    });

    await store.transaction(async () => {
      const idx = issue.tags.indexOf(frontendLabel);
      issue.tags.splice(idx, 1);

      await applyRemote(async (remote) => {
        const remoteIssue = remote.getById(Post, issue.id)!;
        const remoteP0 = remote.getById(Tag, p0Label.id)!;
        remoteIssue.tags.push(remoteP0);
      });

      await store.queryModel(Post);

      expect(issue.tags.map((t) => t.name)).not.toContain("frontend");
    });

    const verify = freshStore();
    await verify.queryAll();
    const labelNames = verify
      .getById(Post, issue.id)!
      .tags.map((t) => t.name)
      .sort();
    expect(labelNames).toEqual(["P0", "bug"]);
  });

  // ---------------------------------------------------------------------------
  // To-one reassignment, you win
  // ---------------------------------------------------------------------------
  it("user reassigns issue to Alice, teammate reassigns to Charlie — Alice wins", async () => {
    const bob = await store.transaction(() => new User("Bob"));
    const alice = await store.transaction(() => new User("Alice"));
    const charlie = await store.transaction(() => new User("Charlie"));
    const issue = await store.transaction(() => {
      const p = new Post("Fix bug");
      p.author = bob;
      return p;
    });

    await store.transaction(async () => {
      issue.author = alice;

      await applyRemote(async (remote) => {
        const remoteIssue = remote.getById(Post, issue.id)!;
        const remoteCharlie = remote.getById(User, charlie.id)!;
        remoteIssue.author = remoteCharlie;
      });

      await store.queryModel(Post);

      expect(issue.author?.id).toBe(alice.id);
    });

    const verify = freshStore();
    await verify.queryAll();
    expect(verify.getById(Post, issue.id)!.author?.id).toBe(alice.id);
  });

  // ---------------------------------------------------------------------------
  // To-one cleared by user, reassigned by teammate — user wins (null in DB)
  //
  // Known limitation: InstantDB has no "unconditionally clear this to-one"
  // primitive. Our commit emits `unlink({author: alice})` (the baseline
  // we knew), but the teammate has since pointed author at Charlie, so
  // the unlink is a no-op against the DB's current state and the clear
  // silently loses. Reliable clearing under concurrent reassign would
  // need refetching DB state at commit time (race-prone) or a new op.
  // ---------------------------------------------------------------------------
  it.skip("user clears assignee, teammate reassigns to Charlie — DB ends unassigned", async () => {
    const alice = await store.transaction(() => new User("Alice"));
    const charlie = await store.transaction(() => new User("Charlie"));
    const issue = await store.transaction(() => {
      const p = new Post("Fix bug");
      p.author = alice;
      return p;
    });

    await store.transaction(async () => {
      issue.author = null;

      await applyRemote(async (remote) => {
        const remoteIssue = remote.getById(Post, issue.id)!;
        const remoteCharlie = remote.getById(User, charlie.id)!;
        remoteIssue.author = remoteCharlie;
      });

      await store.queryModel(Post);

      expect(issue.author).toBeNull();
    });

    const verify = freshStore();
    await verify.queryAll();
    expect(verify.getById(Post, issue.id)!.author).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Rollback only reverts user-touched fields
  // ---------------------------------------------------------------------------
  it("rollback restores user-edited title but keeps teammate's assignee change", async () => {
    const alice = await store.transaction(() => new User("Alice"));
    const bob = await store.transaction(() => new User("Bob"));
    const issue = await store.transaction(() => {
      const p = new Post("Fix bug");
      p.author = alice;
      return p;
    });

    const tx = store.createTransaction();
    await tx.run(async () => {
      issue.title = "Fix login bug";

      await applyRemote(async (remote) => {
        const remoteIssue = remote.getById(Post, issue.id)!;
        const remoteBob = remote.getById(User, bob.id)!;
        remoteIssue.author = remoteBob;
      });

      await store.queryModel(Post);
    });

    tx.rollback();

    // Title reverts (user touched it).
    expect(issue.title).toBe("Fix bug");
    // Assignee stays (user did not touch it; teammate's update should survive).
    expect(issue.author?.id).toBe(bob.id);
  });

  // ---------------------------------------------------------------------------
  // Untouched field receives live update mid-tx
  // ---------------------------------------------------------------------------
  it("user edits title; teammate's description change becomes visible mid-tx", async () => {
    const issue = await store.transaction(() => {
      const p = new Post("Fix bug");
      p.content = "Original description";
      return p;
    });

    await store.transaction(async () => {
      issue.title = "Fix login bug";

      await applyRemote(async (remote) => {
        const remoteIssue = remote.getById(Post, issue.id)!;
        remoteIssue.content = "Teammate added details";
      });

      await store.queryModel(Post);

      // Title: user's value. Description: live teammate update.
      expect(issue.title).toBe("Fix login bug");
      expect(issue.content).toBe("Teammate added details");
    });

    const verify = freshStore();
    await verify.queryAll();
    const stored = verify.getById(Post, issue.id)!;
    expect(stored.title).toBe("Fix login bug");
    expect(stored.content).toBe("Teammate added details");
  });

  // ---------------------------------------------------------------------------
  // Untouched to-many receives live remote add mid-tx
  // ---------------------------------------------------------------------------
  it("user edits title; teammate adds a label — label appears on the issue mid-tx", async () => {
    const bugLabel = await store.transaction(() => new Tag("bug"));
    const p0Label = await store.transaction(() => new Tag("P0"));
    const issue = await store.transaction(() => {
      const p = new Post("Fix bug");
      p.tags.push(bugLabel);
      return p;
    });

    await store.transaction(async () => {
      issue.title = "Fix login bug";

      await applyRemote(async (remote) => {
        const remoteIssue = remote.getById(Post, issue.id)!;
        const remoteP0 = remote.getById(Tag, p0Label.id)!;
        remoteIssue.tags.push(remoteP0);
      });

      await store.queryModel(Post);

      // Title is user's; labels reflect the live teammate update.
      expect(issue.title).toBe("Fix login bug");
      expect(issue.tags.map((t) => t.name).sort()).toEqual(["P0", "bug"]);
    });

    const verify = freshStore();
    await verify.queryAll();
    const stored = verify.getById(Post, issue.id)!;
    expect(stored.title).toBe("Fix login bug");
    expect(stored.tags.map((t) => t.name).sort()).toEqual(["P0", "bug"]);
  });

  // ---------------------------------------------------------------------------
  // Soft-delete mid-tx
  //
  // Contract: deletedAt arrives as a normal hydrator-written field. The
  // hydrator's existing soft-delete path runs (model dropped from identity
  // map, forward refs in other models nulled). The user's local reference
  // still points at the same Model object; its deletedAt is now set so the
  // UI can react. The user's commit ships ONLY the fields they touched —
  // the deletedAt write was the teammate's, not theirs, so it isn't
  // re-emitted from this tx. The row in the DB ends up tombstoned (from
  // the teammate's commit) with the user's title edit on top of it.
  // ---------------------------------------------------------------------------
  it("teammate soft-deletes mid-edit — user's title edit lands on the tombstone", async () => {
    const issue = await store.transaction(() => new Post("Fix bug"));

    await store.transaction(async () => {
      issue.title = "Fix login bug";

      await applyRemote(async (remote) => {
        const remoteIssue = remote.getById(Post, issue.id)!;
        remoteIssue.delete();
      });

      await store.queryModel(Post);

      // The hydrator's soft-delete path orphaned the model from the
      // identity map. The user's local reference still has their edit
      // AND the soft-delete signal (UI can react to deletedAt).
      expect(store.getById(Post, issue.id)).toBeUndefined();
      expect(issue.title).toBe("Fix login bug");
      expect(issue.deletedAt).not.toBeNull();
    });

    // queryModel filters soft-deleted, so the issue is gone from the fresh view.
    const verify = freshStore();
    await verify.queryAll();
    expect(verify.getById(Post, issue.id)).toBeUndefined();

    // But the row IS in the DB with the user's title edit on top of the tombstone.
    const raw = await db.query({ posts: { $: { where: { id: issue.id } } } });
    const row = (raw as { posts?: Array<{ title: string; deletedAt: string }> }).posts?.[0];
    expect(row?.title).toBe("Fix login bug");
    expect(row?.deletedAt).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Parallel txs touch different fields on same issue
  // ---------------------------------------------------------------------------
  it("two parallel txs editing different fields of the same issue both succeed", async () => {
    const issue = await store.transaction(() => {
      const p = new Post("Fix bug");
      p.content = "Original";
      return p;
    });

    const txA = store.createTransaction();
    const txB = store.createTransaction();

    txA.run(() => {
      issue.title = "Fix login bug";
    });
    txB.run(() => {
      issue.content = "Repro: open the page, type credentials...";
    });

    await txA.commit();
    await txB.commit();

    const verify = freshStore();
    await verify.queryAll();
    const stored = verify.getById(Post, issue.id)!;
    expect(stored.title).toBe("Fix login bug");
    expect(stored.content).toBe("Repro: open the page, type credentials...");
  });

  // ---------------------------------------------------------------------------
  // claim.data is per-tx (each tx has its own baseline)
  // ---------------------------------------------------------------------------
  it("each tx has its own claim baseline; second-tx commit ships its own diff", async () => {
    const issue = await store.transaction(() => new Post("Original title"));

    const tx1 = store.createTransaction();
    tx1.run(() => {
      issue.title = "From tx1";
    });
    await tx1.commit();

    // tx2 opens AFTER tx1 commit. Its claim.data should reflect "From tx1",
    // not the long-gone "Original title". Its diff should ship only its own
    // change relative to that baseline.
    const tx2 = store.createTransaction();
    tx2.run(() => {
      issue.title = "From tx2";
    });
    await tx2.commit();

    const verify = freshStore();
    await verify.queryAll();
    expect(verify.getById(Post, issue.id)!.title).toBe("From tx2");
  });
});
