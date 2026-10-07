import { describe, it, expect } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import type { TransactionOutcome } from "../../src/transactions";
import type { SubscriptionFault } from "../../src/subscriptions";
import {
  assertDefined,
  connectTestClient,
  id,
  seedAuthUser,
  wait,
  waitFor,
  type TestStore,
} from "./support/clients";
import { Device } from "./support/Device";
import { User } from "../support/entities/User";
import { Post } from "../support/entities/Post";
import { Tag } from "../support/entities/Tag";

async function seedUsers(...names: string[]): Promise<User[]> {
  const admin = new RootStore({ client: connectTestClient() });
  return admin.transaction(() => names.map((name) => new User(name)));
}

async function seedOwner(): Promise<string> {
  const ownerId = await seedAuthUser(`owner-${id()}@example.com`);
  await new RootStore({ client: connectTestClient() }).transaction(() => new User("Owner", ownerId));
  return ownerId;
}

function userIn(store: TestStore, userId: string): User {
  const user = store.getById(User, userId);
  assertDefined(user);
  return user;
}

const SETTLE_MS = 200;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Offline mode", () => {
  describe("reading offline", () => {
    it("answers queries from the replica for rows pulled earlier", async () => {
      const [kept] = await seedUsers("Kept");
      assertDefined(kept);
      const device = await Device.open();
      await device.store().queryModel(User);

      device.goOffline();

      const offline = device.store();
      const users = await offline.queryModel(User);
      expect(users.map((user) => user.id)).toContain(kept.id);
      expect(userIn(offline, kept.id).name).toBe("Kept");
    });

    it("keeps subscriptions answering while offline and resumes them when back online", async () => {
      const [watched] = await seedUsers("Before");
      assertDefined(watched);
      const device = await Device.open();
      const faults: SubscriptionFault[] = [];
      const store = device.store({ faults });
      const namesSeen: string[] = [];
      await store.subscribeModel(User, (users) => {
        const seen = users.find((user) => user.id === watched.id);
        if (seen) namesSeen.push(seen.name);
      });

      device.goOffline();

      const other = new RootStore({ client: connectTestClient() });
      await other.queryModel(User);
      await other.transaction(() => { userIn(other, watched.id).name = "After"; });
      await wait(SETTLE_MS);
      expect(faults).toEqual([]);
      expect(userIn(store, watched.id).name).toBe("Before");

      device.goOnline();

      await waitFor(() => userIn(store, watched.id).name === "After");
      expect(faults).toEqual([]);
      expect(namesSeen).not.toContain("");
    });
  });

  describe("writing offline", () => {
    it("applies a write locally, keeps it across a restart, and lands it on reconnect", async () => {
      const [author] = await seedUsers("Author");
      assertDefined(author);
      const device = await Device.open();
      const store = device.store();
      await store.queryModel(User);
      const postsSeen: string[][] = [];
      await store.subscribeModel(Post, (posts) => { postsSeen.push(posts.map((post) => post.id)); });

      device.goOffline();

      let post: Post | undefined;
      await expect(store.transaction(() => {
        userIn(store, author.id).name = "Renamed offline";
        post = new Post("Written offline", userIn(store, author.id));
      })).resolves.toBeUndefined();
      assertDefined(post);
      const postId = post.id;
      expect(userIn(store, author.id).name).toBe("Renamed offline");
      await waitFor(() => postsSeen.some((ids) => ids.includes(postId)));

      const restarted = device.reopen();
      const fresh = restarted.store();
      await fresh.queryModel(User);
      await fresh.queryModel(Post);
      expect(userIn(fresh, author.id).name).toBe("Renamed offline");
      expect(fresh.getById(Post, postId)?.author?.id).toBe(author.id);

      restarted.goOnline();

      const other = new RootStore({ client: connectTestClient() });
      await waitFor(async () => (await other.queryModel(Post)).some((candidate) => candidate.id === postId));
      await other.queryModel(User);
      expect(userIn(other, author.id).name).toBe("Renamed offline");
      expect(other.getById(Post, postId)?.author?.id).toBe(author.id);
    });

    it("lands several offline transactions in the order they were made", async () => {
      const device = await Device.open();
      const denials: TransactionOutcome[] = [];
      const store = device.store({ denials });
      await store.queryModel(User);

      device.goOffline();

      const newUser = await store.transaction(() => new User("Made offline"));
      const post = await store.transaction(() => new Post("By the new user", newUser));
      await store.transaction(() => { newUser.name = "Renamed offline"; });

      device.goOnline();

      const other = new RootStore({ client: connectTestClient() });
      await waitFor(async () => (await other.queryModel(Post)).some((candidate) => candidate.id === post.id));
      await other.queryModel(User);
      expect(userIn(other, newUser.id).name).toBe("Renamed offline");
      expect(other.getById(Post, post.id)?.author?.id).toBe(newUser.id);
      expect(denials).toEqual([]);
      expect(userIn(store, newUser.id).name).toBe("Renamed offline");
    });

    it("applies a transaction once when its effect was lost and it is sent again", async () => {
      const device = await Device.open();
      const denials: TransactionOutcome[] = [];
      const store = device.store({ denials });
      await store.queryModel(Post);
      const other = new RootStore({ client: connectTestClient() });
      await other.subscribeModel(Post, () => undefined);

      device.loseNextServerFrame();
      const post = await store.transaction(() => new Post("Exactly once"));

      device.goOnline();

      await waitFor(() => other.getAll(Post).some((candidate) => candidate.id === post.id));
      await wait(SETTLE_MS);
      expect(other.getAll(Post).filter((candidate) => candidate.id === post.id)).toHaveLength(1);
      expect(store.getAll(Post).filter((candidate) => candidate.id === post.id)).toHaveLength(1);
      expect(denials).toEqual([]);
    });
  });

  describe("denial after reconnect", () => {
    it("undoes an offline write the server denies, and reports it", async () => {
      const ownerId = await seedOwner();
      const device = await Device.open(`intruder-${id()}@example.com`);
      const denials: TransactionOutcome[] = [];
      const store = device.store({ denials });
      await store.queryModel(User);

      device.goOffline();

      await store.transaction(() => { userIn(store, ownerId).name = "Hacked"; });
      expect(userIn(store, ownerId).name).toBe("Hacked");

      device.goOnline();

      await waitFor(() => denials.length === 1);
      expect(denials[0]?.reason).toMatch(/polic/i);
      expect(userIn(store, ownerId).name).toBe("Owner");
      const fresh = device.store();
      await fresh.queryModel(User);
      expect(userIn(fresh, ownerId).name).toBe("Owner");
      const other = new RootStore({ client: connectTestClient() });
      await other.queryModel(User);
      expect(userIn(other, ownerId).name).toBe("Owner");
    });

    it("undoes a denied offline write even after a restart", async () => {
      const ownerId = await seedOwner();
      const device = await Device.open(`intruder-${id()}@example.com`);
      const store = device.store();
      await store.queryModel(User);

      device.goOffline();
      await store.transaction(() => { userIn(store, ownerId).name = "Hacked"; });

      const restarted = device.reopen();
      const denials: TransactionOutcome[] = [];
      const fresh = restarted.store({ denials });
      await fresh.queryModel(User);
      expect(userIn(fresh, ownerId).name).toBe("Hacked");

      restarted.goOnline();

      await waitFor(() => denials.length === 1);
      expect(denials[0]?.reason).toMatch(/polic/i);
      await waitFor(() => userIn(fresh, ownerId).name === "Owner");
      const another = restarted.store();
      await another.queryModel(User);
      expect(userIn(another, ownerId).name).toBe("Owner");
    });
  });

  describe("catching up", () => {
    it("receives everything that happened while offline, also after a restart, and only once", async () => {
      const [renamed, newAuthor, doomed] = await seedUsers("Old name", "New author", "Doomed");
      assertDefined(renamed);
      assertDefined(newAuthor);
      assertDefined(doomed);
      const seed = new RootStore({ client: connectTestClient() });
      await seed.queryModel(User);
      const { tagged, deleted } = await seed.transaction(() => {
        const tag = new Tag("tag");
        const tagged = new Post("Tagged", userIn(seed, renamed.id));
        tagged.tags.push(tag);
        return { tagged, deleted: new Post("Deleted") };
      });

      const device = await Device.open();
      await device.store().queryModel(User);
      await device.store().queryModel(Post);
      device.goOffline();

      const other = new RootStore({ client: connectTestClient() });
      await other.queryModel(User);
      await other.queryModel(Post);
      const created = await other.transaction(() => new User("Created while away"));
      await other.transaction(() => { userIn(other, renamed.id).name = "New name"; });
      await other.transaction(() => {
        const post = other.getById(Post, tagged.id);
        assertDefined(post);
        post.author = userIn(other, newAuthor.id);
        post.tags.splice(0, post.tags.length);
      });
      await other.transaction(() => { other.getById(Post, deleted.id)?.delete(); });
      await other.transaction(() => { userIn(other, doomed.id).softDelete(); });

      const restarted = device.reopen();
      const store = restarted.store();
      let userSnapshots = 0;
      await store.subscribeModel(User, () => { userSnapshots += 1; });
      await store.subscribeModel(Post, () => undefined);
      expect(userIn(store, renamed.id).name).toBe("Old name");

      restarted.goOnline();
      await waitFor(() => userIn(store, renamed.id).name === "New name");
      await waitFor(() => store.getById(User, created.id) !== undefined);
      await waitFor(() => store.getById(Post, tagged.id)?.author?.id === newAuthor.id);
      expect(store.getById(Post, tagged.id)?.tags).toEqual([]);
      await waitFor(() => store.getById(Post, deleted.id) === undefined);
      await waitFor(() => store.getById(User, doomed.id) === undefined);

      const settled = userSnapshots;
      restarted.goOffline();
      restarted.goOnline();
      await wait(SETTLE_MS);
      expect(userIn(store, renamed.id).name).toBe("New name");
      expect(userSnapshots).toBe(settled);
    });
  });
});
