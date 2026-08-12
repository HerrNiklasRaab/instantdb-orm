import { describe, it, beforeEach } from "vitest";
import {
  assertDefined,
  setupTestDatabase,
  waitFor,
  type TestInstantDBClient,
} from "./support/instantdb-test-utils";
import { RootStore } from "../../src/object-graph/store/RootStore";
import type { AppSchema } from "../support/instant.schema";
import { User } from "../support/entities/User";

describe("subscribeQueryIsolated (curr, prev)", () => {
  let db: TestInstantDBClient;

  beforeEach(() => {
    db = setupTestDatabase();
  });

  it("lets the handler detect deletion by diffing identity maps", async () => {
    const seedStore = new RootStore<AppSchema>({ db });
    const u = await seedStore.transaction(() => new User("doomed"));

    const store = new RootStore<AppSchema>({ db });
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

    const deleteStore = new RootStore<AppSchema>({ db });
    await deleteStore.queryModel(User);
    await deleteStore.transaction(() => {
      const target = deleteStore.getById(User, u.id);
      assertDefined(target);
      target.delete();
    });

    await waitFor(() => removalEvents.includes(u.id), 8000);

    sub.close();
  });

  it("lets the handler detect a status x → y transition", async () => {
    // Seed an entity in state x.
    const seedStore = new RootStore<AppSchema>({ db });
    const u = await seedStore.transaction(() => new User("transitioning"));

    const store = new RootStore<AppSchema>({ db });
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
    const mutateStore = new RootStore<AppSchema>({ db });
    await mutateStore.queryModel(User);
    await mutateStore.transaction(() => {
      const target = mutateStore.getById(User, u.id);
      assertDefined(target);
      target.name = "transitioned";
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

  // A reactor spots its work by absence from `prev`. If a throwing handler
  // still advanced `prev`, the entity it choked on would be "already seen" from
  // then on and never processed again — a silent, permanent drop.
  it("keeps an entity new to the handler after the handler threw on it", async () => {
    const store = new RootStore<AppSchema>({ db });
    const seen: string[] = [];
    let thrown = false;

    const sub = await store.subscribeQueryIsolated(
      { users: {} },
      (curr, prev) => {
        for (const user of curr.getAll(User)) {
          if (prev?.getById(User, user.id)) continue;
          if (!thrown) {
            thrown = true;
            throw new Error("handler blew up on first sight");
          }
          seen.push(user.id);
        }
      }
    );

    const seedStore = new RootStore<AppSchema>({ db });
    const u = await seedStore.transaction(() => new User("survivor"));

    await waitFor(() => thrown, 8000);
    // Any later callback must still offer the same user as unseen.
    await seedStore.transaction(() => new User("nudge"));

    await waitFor(() => seen.includes(u.id), 8000);

    sub.close();
  });
});
