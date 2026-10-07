import { describe, it, expect, beforeEach } from "vitest";
import { Temporal } from "../../src/object-graph";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { Post } from "../support/entities/Post";
import { User } from "../support/entities/User";
import {
  assertDefined,
  connectTestClient,
  waitFor,
  type TestClient,
  type TestStore,
} from "./support/clients";

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
  let client: TestClient;
  let store: TestStore;

  beforeEach(() => {
    client = connectTestClient();
    store = new RootStore({ client: connectTestClient() });
  });

  async function userRowState(id: string): Promise<RowState> {
    const result = await client.query({ users: { where: { id } } });
    const rows = userRows(result);
    if (rows.length === 0) return "absent";
    const [row] = rows;
    if (!row) return "absent";
    return rowDeletedAt(row) ? "softDeleted" : "present";
  }

  it("soft-deletes before physically deleting the row", async () => {
    const user = await store.transaction(() => new User("Test User"));
    const states: RowState[] = [];
    const originalSubmit = store.client.submit.bind(store.client);

    store.client.submit = async (batch) => {
      await originalSubmit(batch);
      await store.client.verdict(batch.id);
      states.push(await userRowState(user.id));
    };

    try {
      await store.transaction(() => { user.delete(); }).settled();
      await waitFor(() => states.length === 2);
    } finally {
      store.client.submit = originalSubmit;
    }

    expect(states).toEqual(["softDeleted", "absent"]);
    expect(await userRowState(user.id)).toBe("absent");
  });

  it("leaves a soft-deleted row when the physical delete fails", async () => {
    const user = await store.transaction(() => new User("Test User"));
    const originalSubmit = store.client.submit.bind(store.client);
    let calls = 0;

    store.client.submit = async (batch) => {
      calls += 1;
      if (calls === 2) throw new Error("physical delete failed");
      await originalSubmit(batch);
    };

    try {
      const { outcome } = await store.transaction(() => { user.delete(); }).settled();
      expect(outcome.status).toBe("committed");
      await waitFor(() => calls === 2);
    } finally {
      store.client.submit = originalSubmit;
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
    const verificationStore = new RootStore({ client: connectTestClient() });
    await verificationStore.queryModel(User);
    expect(verificationStore.getById(User, user.id)).toBeDefined();
  });

  it("ignores same-model updates on a hard-deleted row", async () => {
    const post = await store.transaction(() => new Post("Original"));

    await store.transaction(() => {
      post.title = "Updated";
      post.delete();
    });

    const verificationStore = new RootStore({ client: connectTestClient() });
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
    const storeA = new RootStore({ client: connectTestClient() });
    const storeB = new RootStore({ client: connectTestClient() });
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
