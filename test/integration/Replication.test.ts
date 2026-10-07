import { describe, it, expect } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { Transaction } from "../../src/transactions";
import { isRecord } from "../../src/queries";
import {
  committedChanges,
  committedTransactions,
  connectTestClient,
  id,
  openTestClient,
  openTestClientAs,
  registerIdentity,
  seedAuthUser,
  waitFor,
} from "./support/clients";
import { User } from "../support/entities/User";
import { Post } from "../support/entities/Post";
import { Tag } from "../support/entities/Tag";
import { Room } from "../support/entities/Room";
import { RoomMember } from "../support/entities/RoomMember";

async function loggedTransaction(transactionId: string): Promise<Record<string, unknown> | undefined> {
  const log = await committedTransactions();
  return log.filter(isRecord).find((entry) => entry.id === transactionId);
}

async function loggedChanges(transactionId: string): Promise<Record<string, unknown>[]> {
  const changes = await committedChanges();
  return changes.filter(isRecord).filter((change) => change.transactionId === transactionId);
}

describe("Replication between clients", () => {
  it("records a committed transaction in the server log with a tick and a commit time", async () => {
    const { client } = await openTestClient();
    const userId = id();
    const now = new Date().toISOString();
    const transaction = new Transaction().create("users", userId, { name: "Logged", createdAt: now, updatedAt: now });

    await client.commit(transaction);

    const entry = await loggedTransaction(transaction.id);
    expect(entry?.tick).toBeTypeOf("number");
    expect(entry?.status).toBe("committed");
    expect(entry?.loggedAt).toBeInstanceOf(Date);
    expect(await loggedChanges(transaction.id)).toEqual([
      {
        transactionId: transaction.id,
        position: 0,
        kind: "create",
        entity: "users",
        entityId: userId,
        field: null,
        values: { name: "Logged", createdAt: now, updatedAt: now },
        links: null,
        targetIds: null,
      },
    ]);
  });

  it("logs one change row per change, in the order the transaction lists them", async () => {
    const { client } = await openTestClient();
    const userId = id();
    const postId = id();
    const tagId = id();
    const now = new Date().toISOString();
    const transaction = new Transaction()
      .create("users", userId, { name: "Author", createdAt: now, updatedAt: now })
      .create("posts", postId, { title: "Hello", createdAt: now, updatedAt: now }, { author: userId })
      .create("tags", tagId, { name: "news", createdAt: now, updatedAt: now })
      .link("posts", postId, "tags", [tagId]);

    await client.commit(transaction);

    const changes = await loggedChanges(transaction.id);
    expect(changes.map(({ position, kind, entity, entityId }) => ({ position, kind, entity, entityId }))).toEqual([
      { position: 0, kind: "create", entity: "users", entityId: userId },
      { position: 1, kind: "create", entity: "posts", entityId: postId },
      { position: 2, kind: "create", entity: "tags", entityId: tagId },
      { position: 3, kind: "link", entity: "posts", entityId: postId },
    ]);
    expect(changes[1]).toMatchObject({ links: { author: userId }, targetIds: null });
    expect(changes[3]).toMatchObject({ field: "tags", targetIds: [tagId], values: null, links: null });
  });

  it("orders the log by commit and attributes each transaction to its author", async () => {
    const email = `author-${id()}@example.com`;
    const authorId = await seedAuthUser(email);
    const { client } = await openTestClientAs(email);
    const now = new Date().toISOString();
    const first = new Transaction().create("posts", id(), { title: "one", createdAt: now, updatedAt: now });
    const second = new Transaction().create("posts", id(), { title: "two", createdAt: now, updatedAt: now });

    await client.commit(first);
    await client.commit(second);

    const firstEntry = await loggedTransaction(first.id);
    const secondEntry = await loggedTransaction(second.id);
    expect(firstEntry?.authorId).toBe(authorId);
    expect(Number(secondEntry?.tick)).toBeGreaterThan(Number(firstEntry?.tick));
  });

  it("logs a denied transaction as denied, with its changes, and applies nothing", async () => {
    const ownerEmail = `owner-${id()}@example.com`;
    const ownerId = await seedAuthUser(ownerEmail);
    const admin = await openTestClient();
    const now = new Date().toISOString();
    await admin.client.commit(new Transaction().create("users", ownerId, { name: "Owner", createdAt: now, updatedAt: now }));

    const intruder = await openTestClientAs(`intruder-${id()}@example.com`);
    const denied = new Transaction().update("users", ownerId, { name: "Hacked" });

    const outcome = await intruder.client.commit(denied);

    expect(outcome.transactionId).toBe(denied.id);
    expect(outcome.status).toBe("denied");
    expect(outcome.reason).toMatch(/polic/i);
    expect(await loggedTransaction(denied.id)).toMatchObject({ status: "denied", reason: outcome.reason });
    expect(await loggedChanges(denied.id)).toHaveLength(1);
    const [owner] = (await admin.replica.read({ users: { where: { id: ownerId } } })).users ?? [];
    expect(owner?.name).toBe("Owner");
  });

  it("fills each client's replica with the buckets it holds, and nothing else", async () => {
    const admin = new RootStore({ client: connectTestClient() });
    const aliceEmail = `alice-${id()}@example.com`;
    const aliceId = registerIdentity(aliceEmail);
    const [hers, theirs] = await admin.transaction(() => {
      const mine = new Room("hers");
      mine.members.push(new RoomMember(aliceId, mine));
      return [mine, new Room("theirs")] as const;
    });

    const alice = await openTestClientAs(aliceEmail);
    await waitFor(async () => ((await alice.replica.read({ rooms: {} })).rooms?.length ?? 0) > 0);
    expect((await alice.replica.read({ rooms: {} })).rooms?.map((row) => row.id)).toEqual([hers.id]);

    const service = await openTestClient();
    await waitFor(async () => ((await service.replica.read({ rooms: {} })).rooms?.length ?? 0) >= 2);
    const ids = (await service.replica.read({ rooms: {} })).rooms?.map((row) => row.id) ?? [];
    expect(ids).toContain(hers.id);
    expect(ids).toContain(theirs.id);
  });

  it("delivers another client's transaction into the replica without a new pull", async () => {
    const writer = await openTestClient();
    const reader = await openTestClient();
    const writerStore = new RootStore({ client: writer.client });

    const user = await writerStore.transaction(() => new User("Pushed"));

    await waitFor(async () => (await reader.replica.read({ users: { where: { id: user.id } } })).users?.length === 1);
    const [row] = (await reader.replica.read({ users: { where: { id: user.id } } })).users ?? [];
    expect(row?.name).toBe("Pushed");
  });

  it("replicates updates, links and deletes to another client's replica", async () => {
    const writer = await openTestClient();
    const reader = await openTestClient();
    const store = new RootStore({ client: writer.client });
    const readPost = async (postId: string) =>
      (await reader.replica.read({
        posts: { where: { id: postId }, include: { author: { select: { id: true } }, tags: { select: { id: true } } } },
      })).posts?.[0];

    const { author, tag, post } = await store.transaction(() => {
      const author = new User("Author");
      const tag = new Tag("news");
      const post = new Post("Draft", author);
      post.tags.push(tag);
      return { author, tag, post };
    });
    await waitFor(async () => (await readPost(post.id)) !== undefined);
    expect(await readPost(post.id)).toMatchObject({ title: "Draft", author: { id: author.id }, tags: [{ id: tag.id }] });

    await store.transaction(() => {
      post.title = "Published";
      post.tags.splice(0, 1);
    });
    await waitFor(async () => (await readPost(post.id))?.title === "Published");
    expect(await readPost(post.id)).toMatchObject({ title: "Published", tags: [] });

    await store.transaction(() => { post.delete(); });
    await waitFor(async () => (await readPost(post.id)) === undefined);
  });

  it("keeps a field the server withheld out of the other client's replica", async () => {
    const ownerEmail = `owner-${id()}@example.com`;
    const ownerId = await seedAuthUser(ownerEmail);
    const viewer = await openTestClientAs(`viewer-${id()}@example.com`);
    const owner = await openTestClientAs(ownerEmail);
    const admin = await openTestClient();
    const now = new Date().toISOString();

    await admin.client.commit(
      new Transaction().create("users", ownerId, { name: "Owner", secretField: "s3cret", createdAt: now, updatedAt: now }),
    );

    await waitFor(async () => (await viewer.replica.read({ users: { where: { id: ownerId } } })).users?.length === 1);
    await waitFor(async () => (await owner.replica.read({ users: { where: { id: ownerId } } })).users?.length === 1);
    const [seenByViewer] = (await viewer.replica.read({ users: { where: { id: ownerId } } })).users ?? [];
    const [seenByOwner] = (await owner.replica.read({ users: { where: { id: ownerId } } })).users ?? [];
    expect(seenByViewer?.name).toBe("Owner");
    expect(seenByViewer).not.toHaveProperty("secretField");
    expect(seenByOwner?.secretField).toBe("s3cret");
  });

  it("answers a subscription from the replica as other clients commit", async () => {
    const writer = await openTestClient();
    const reader = await openTestClient();
    const writerStore = new RootStore({ client: writer.client });
    const readerStore = new RootStore({ client: reader.client });
    await readerStore.subscribeModel(User, () => undefined);

    const user = await writerStore.transaction(() => new User("Live"));
    await waitFor(() => readerStore.getById(User, user.id) !== undefined);

    await writerStore.transaction(() => { user.name = "Renamed"; });
    await waitFor(() => readerStore.getById(User, user.id)?.name === "Renamed");
  });
});
