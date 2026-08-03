import { describe, it, expect, beforeEach } from "vitest";
import { Temporal } from "../../src/object-graph";
import { RootStore } from "../../src/object-graph/store/RootStore";
import type { AppSchema } from "../support/instant.schema";
import { Post } from "../support/entities/Post";
import { User } from "../support/entities/User";
import {
  assertDefined,
  setupTestDatabase,
  waitFor,
  type TestInstantDBClient,
} from "./support/instantdb-test-utils";

type RowState = "absent" | "present" | "softDeleted";

function userRows(result: unknown): object[] {
  if (result === null || typeof result !== "object") return [];
  const rows: unknown = Reflect.get(result, "users");
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is object => row !== null && typeof row === "object");
}

function rowDeletedAt(row: object): string | undefined {
  const deletedAt: unknown = Reflect.get(row, "deletedAt");
  return typeof deletedAt === "string" ? deletedAt : undefined;
}

describe("Hard Delete (Integration)", () => {
  let db: TestInstantDBClient;
  let store: RootStore<AppSchema>;

  beforeEach(() => {
    db = setupTestDatabase();
    store = new RootStore<AppSchema>({ db });
  });

  async function userRowState(id: string): Promise<RowState> {
    const result = await db.query({ users: { $: { where: { id } } } });
    const rows = userRows(result);
    if (rows.length === 0) return "absent";
    const [row] = rows;
    if (!row) return "absent";
    return rowDeletedAt(row) ? "softDeleted" : "present";
  }

  it("soft-deletes before physically deleting the row", async () => {
    const user = await store.transaction(() => new User("Test User"));
    const states: RowState[] = [];
    const originalTransact = store.db.transact.bind(store.db);

    store.db.transact = async (chunks) => {
      await originalTransact(chunks);
      states.push(await userRowState(user.id));
    };

    try {
      await store.transaction(() => { user.delete(); });
    } finally {
      store.db.transact = originalTransact;
    }

    expect(states).toEqual(["softDeleted", "absent"]);
    expect(await userRowState(user.id)).toBe("absent");
  });

  it("leaves a soft-deleted row when the physical delete fails", async () => {
    const user = await store.transaction(() => new User("Test User"));
    const originalTransact = store.db.transact.bind(store.db);
    let calls = 0;

    store.db.transact = async (chunks) => {
      calls += 1;
      if (calls === 2) throw new Error("physical delete failed");
      await originalTransact(chunks);
    };

    try {
      await expect(store.transaction(() => { user.delete(); })).rejects.toThrow(
        "physical delete failed"
      );
    } finally {
      store.db.transact = originalTransact;
    }

    expect(await userRowState(user.id)).toBe("softDeleted");
    expect(user.deletedAt).toBeInstanceOf(Temporal.Instant);
    expect(store.getById(User, user.id)).toBeUndefined();
  });

  it("cleans the local object graph after commit", async () => {
    const user = await store.transaction(() => new User("Author"));
    const post = await store.transaction(() => {
      const p = new Post("Post");
      p.author = user;
      return p;
    });

    expect(user.posts).toContain(post);
    expect(post.author).toBe(user);

    await store.transaction(() => { post.delete(); });

    expect(store.getById(Post, post.id)).toBeUndefined();
    expect(user.posts).not.toContain(post);
  });

  it("rolls back a pending hard delete", async () => {
    const user = await store.transaction(() => new User("Test User"));
    const tx = store.createTransaction();

    tx.run(() => { user.delete(); });
    tx.rollback();

    expect(store.getById(User, user.id)).toBe(user);
    expect(user.deletedAt).toBeNull();
    const verificationStore = new RootStore<AppSchema>({ db });
    await verificationStore.queryModel(User);
    expect(verificationStore.getById(User, user.id)).toBeDefined();
  });

  it("ignores same-model updates on a hard-deleted row", async () => {
    const post = await store.transaction(() => new Post("Original"));

    await store.transaction(() => {
      post.title = "Updated";
      post.delete();
    });

    const verificationStore = new RootStore<AppSchema>({ db });
    await verificationStore.queryModel(Post);
    expect(verificationStore.getById(Post, post.id)).toBeUndefined();
  });

  // softDelete, not delete(): a server-computed stream only guarantees it
  // eventually reflects the final state. delete()'s two commits can coalesce
  // into one recomputation that skips the tombstone state, and the final
  // state of a completed delete carries no trace — the tombstone emission is
  // only guaranteed while the tombstone IS the final state.
  it("drops a soft-deleted row from a live subscriber when its tombstone arrives", async () => {
    const user = await store.transaction(() => new User("Test User"));
    const storeA = new RootStore<AppSchema>({ db });
    const storeB = new RootStore<AppSchema>({ db });
    const subscription = await storeA.subscribeModel(User, () => {});

    await waitFor(() => storeA.getById(User, user.id) !== undefined);
    await storeB.queryModel(User);
    const toDelete = storeB.getById(User, user.id);
    assertDefined(toDelete);
    await storeB.transaction(() => { toDelete.softDelete(); });

    await waitFor(() => storeA.getById(User, user.id) === undefined, 8000);
    subscription.close();
  });
});
