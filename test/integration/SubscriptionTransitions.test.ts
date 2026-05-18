import { describe, it, beforeEach } from "vitest";
import {
  setupTestDatabase,
  waitFor,
  type TestInstantDBClient,
} from "./support/instantdb-test-utils";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { User } from "../support/entities/User";

describe("subscribeQueryIsolated (curr, prev)", () => {
  let db: TestInstantDBClient;

  beforeEach(() => {
    db = setupTestDatabase();
  });

  it("lets the handler detect deletion by diffing identity maps", async () => {
    const seedStore = new RootStore({ db });
    const u = await seedStore.transaction(() => new User("doomed"));

    const store = new RootStore({ db });
    const removalEvents: string[] = [];

    const sub = await store.subscribeQueryIsolated(
      { users: {} },
      (curr, prev) => {
        if (!prev) return;
        for (const before of prev.getAll(User)) {
          if (!curr.getById(User, before.id)) {
            removalEvents.push(before.id);
          }
        }
      }
    );

    // Wait for the seeded user to land in a callback
    await waitFor(() => {
      // hack: nothing observable until something is removed
      return true;
    }, 1000).catch(() => { });

    const deleteStore = new RootStore({ db });
    await deleteStore.queryModel(User);
    await deleteStore.transaction(() => { deleteStore.getById(User, u.id)!.delete(); });

    await waitFor(() => removalEvents.includes(u.id), 8000);

    sub.close();
  });

  it("lets the handler detect a status x → y transition", async () => {
    // Seed an entity in state x.
    const seedStore = new RootStore({ db });
    const u = await seedStore.transaction(() => new User("transitioning"));

    const store = new RootStore({ db });
    const transitions: { id: string; before: string; after: string }[] = [];

    const sub = await store.subscribeQueryIsolated(
      { users: {} },
      (curr, prev) => {
        if (!prev) return;
        for (const after of curr.getAll(User)) {
          const before = prev.getById(User, after.id);
          if (before && before.name !== after.name) {
            transitions.push({ id: after.id, before: before.name, after: after.name });
          }
        }
      }
    );

    // Wait until first callback has fired.
    const mutateStore = new RootStore({ db });
    await mutateStore.queryModel(User);
    await mutateStore.transaction(async () => {
      mutateStore.getById(User, u.id)!.name = "transitioned";
    });

    await waitFor(
      () =>
        transitions.some(
          (t) => t.id === u.id && t.before === "transitioning" && t.after === "transitioned"
        ),
      8000
    );

    sub.close();
  });
});
