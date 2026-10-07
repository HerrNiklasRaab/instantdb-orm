import { describe, expect, it } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import type { TransactionOutcome } from "../../src/transactions";
import { assertDefined, connectTestClient, connectTestClientAs, id, seedAuthUser, wait } from "./support/clients";
import { Device } from "./support/Device";
import { Post } from "../support/entities/Post";
import { Room } from "../support/entities/Room";
import { User } from "../support/entities/User";

const REPLY_LATENCY_MS = 500;

async function seedOwner(): Promise<string> {
  const ownerId = await seedAuthUser(`owner-${id()}@example.com`);
  await new RootStore({ client: connectTestClient() }).transaction(() => new User("Owner", ownerId));
  return ownerId;
}

describe("A store transaction", () => {
  it("resolves once applied locally, without waiting for the server's answer", async () => {
    const store = new RootStore({ client: connectTestClient({ replyLatencyMs: REPLY_LATENCY_MS }) });
    await store.queryModel(Post);

    const started = Date.now();
    const post = await store.transaction(() => new Post("local first"));

    expect(Date.now() - started).toBeLessThan(REPLY_LATENCY_MS / 2);
    expect(store.getById(Post, post.id)?.title).toBe("local first");
  });

  it("settles as committed, with the result and the server's tick", async () => {
    const store = new RootStore({ client: connectTestClient() });

    const { result, outcome } = await store.transaction(() => new Post("kept")).settled();

    expect(result.title).toBe("kept");
    expect(outcome.status).toBe("committed");
    expect(outcome.tick).toBeTypeOf("number");
  });

  it("settles as denied with the reason, instead of throwing", async () => {
    const ownerId = await seedOwner();
    const intruder = new RootStore({ client: connectTestClientAs(`intruder-${id()}@example.com`) });
    const owner = (await intruder.queryModel(User)).find((user) => user.id === ownerId);
    assertDefined(owner);

    const { outcome } = await intruder.transaction(() => { owner.name = "Hacked"; }).settled();

    expect(outcome.status).toBe("denied");
    expect(outcome.reason).toMatch(/polic/i);
    expect(owner.name).toBe("Owner");
  });

  it("settles an offline transaction once the device is back online", async () => {
    const device = await Device.open();
    const store = device.store();
    await store.queryModel(Post);
    device.goOffline();

    const handle = store.transaction(() => new Post("written offline"));
    let settled: TransactionOutcome | null = null;
    void handle.settled().then(({ outcome }) => { settled = outcome; });
    await handle;
    await wait(200);
    expect(settled).toBeNull();

    device.goOnline();
    const { outcome } = await handle.settled();
    expect(outcome.status).toBe("committed");
  });

  it("stops waiting for the verdict when the caller aborts", async () => {
    const device = await Device.open();
    const store = device.store();
    await store.queryModel(Post);
    device.goOffline();
    const abort = new AbortController();

    const waiting = store.transaction(() => new Post("never confirmed here")).settled({ signal: abort.signal });
    abort.abort();

    await expect(waiting).rejects.toThrow(/abort/i);
  });

  // rooms.inviteCode is required: a room without one is refused by the
  // database itself, whatever the access policies say.
  it("settles as denied when the database refuses the write, and takes it back", async () => {
    const store = new RootStore({ client: connectTestClient() });

    const handle = store.transaction(() => {
      const room = new Room("no code", null);
      room.inviteCode = undefined;
      return room;
    });
    const { result: room, outcome } = await handle.settled();

    expect(outcome.status).toBe("denied");
    expect(outcome.reason).toMatch(/inviteCode/);
    expect(store.getById(Room, room.id)).toBeUndefined();
  });

  it("settles an offline write the database refuses once back online, and reports it", async () => {
    const device = await Device.open();
    const denials: TransactionOutcome[] = [];
    const store = device.store({ denials });
    await store.queryModel(Room);
    device.goOffline();

    const handle = store.transaction(() => {
      const room = new Room("no code, offline", null);
      room.inviteCode = undefined;
      return room;
    });
    await handle;
    device.goOnline();
    const { outcome } = await handle.settled();

    expect(outcome.status).toBe("denied");
    expect(denials.map((denial) => denial.transactionId)).toEqual([outcome.transactionId]);
  });
});
