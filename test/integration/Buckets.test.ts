import { describe, expect, it } from "vitest";
import { schema as tightenedSchema } from "../support/zenstack/tightened/schema";
import { Room } from "../support/entities/Room";
import { RoomMessage } from "../support/entities/RoomMessage";
import { assertDefined, redeployServer, wait, waitFor } from "./support/clients";
import { mentions, person, RoomAdmin, watchMessages, type Person } from "./support/rooms";

const SETTLE_MS = 200;

function texts(messages: RoomMessage[]): string[] {
  return messages.map((message) => message.text).sort();
}

/** Member of `room` posts through their own store, as the app would. */
async function say(who: Person, room: Room, text: string): Promise<void> {
  await who.store.caughtUp();
  const rooms = who.store.getAll(Room);
  const mine = rooms.find((candidate) => candidate.id === room.id);
  assertDefined(mine, `${who.userId} cannot see ${room.name}`);
  await who.store.transaction(() => new RoomMessage(text, mine));
}


describe("Buckets", () => {
  it("delivers a change only to the holders of its bucket", async () => {
    const admin = new RoomAdmin();
    const [alice, bob, carol] = await Promise.all([person("Alice"), person("Bob"), person("Carol")]);
    const room1 = await admin.createRoom("room 1", [alice.userId, bob.userId]);
    const room2 = await admin.createRoom("room 2", [carol.userId]);
    const bobSees = await watchMessages(bob);
    const carolSees = await watchMessages(carol);
    await admin.post(room2, "hello carol");
    await waitFor(() => texts(carolSees).includes("hello carol"));
    const carolFrames = carol.device.framesReceived();

    await say(alice, room1, "hello bob");

    await waitFor(() => texts(bobSees).includes("hello bob"));
    await wait(SETTLE_MS);
    expect(carol.device.framesReceived()).toBe(carolFrames);
    expect(texts(carolSees)).toEqual(["hello carol"]);
    await carol.store.caughtUp();
    expect(texts(carol.store.getAll(RoomMessage))).toEqual(["hello carol"]);
  });

  it("delivers the rows a newly gained bucket already holds", async () => {
    const admin = new RoomAdmin();
    const [alice, carol] = await Promise.all([person("Alice"), person("Carol")]);
    const room1 = await admin.createRoom("room 1", [alice.userId]);
    await admin.post(room1, "one", "two", "three");
    const carolSees = await watchMessages(carol);
    expect(carolSees).toEqual([]);

    await admin.addMember(room1, carol.userId);

    await waitFor(() => texts(carolSees).length === 3);
    expect(texts(carolSees)).toEqual(["one", "three", "two"]);
    await carol.store.caughtUp();
    expect(carol.store.getAll(Room).map((room) => room.name)).toEqual(["room 1"]);

    await say(alice, room1, "four");
    await waitFor(() => texts(carolSees).includes("four"));
  });

  it("removes a lost bucket's rows and stops delivering to it", async () => {
    const admin = new RoomAdmin();
    const [alice, carol] = await Promise.all([person("Alice"), person("Carol")]);
    const room1 = await admin.createRoom("room 1", [alice.userId, carol.userId]);
    await admin.post(room1, "one", "two", "three");
    const carolSees = await watchMessages(carol);
    await waitFor(() => texts(carolSees).length === 3);

    await admin.removeMember(room1, carol.userId);

    await waitFor(() => carolSees.length === 0);
    await carol.store.caughtUp();
    expect(carol.store.getAll(Room)).toEqual([]);
    const carolFrames = carol.device.framesReceived();
    await say(alice, room1, "four");
    await wait(SETTLE_MS);
    expect(carol.device.framesReceived()).toBe(carolFrames);
    expect(carolSees).toEqual([]);
  });

  it("catches up only on the buckets it holds after reconnecting", async () => {
    const admin = new RoomAdmin();
    const [alice, bob] = await Promise.all([person("Alice"), person("Bob")]);
    const room1 = await admin.createRoom("room 1", [alice.userId, bob.userId]);
    const room2 = await admin.createRoom("room 2", []);
    const bobSees = await watchMessages(bob);

    bob.device.goOffline();
    await say(alice, room1, "room-1 message 0");
    await say(alice, room1, "room-1 message 1");
    for (let i = 0; i < 30; i++) await admin.post(room2, `room-2 message ${i}`);
    const beforeReconnect = bob.device.framesReceived();
    bob.device.goOnline();

    await waitFor(() => bobSees.length === 2);
    expect(texts(bobSees).every((text) => text.startsWith("room-1"))).toBe(true);
    const catchUp = bob.device.framesSince(beforeReconnect);
    expect(mentions(catchUp, "room-2 message")).toBe(false);
    // Thirty of the transactions were in a room Bob is not in; a catch-up that
    // replays the whole log costs a frame for each of them.
    expect(catchUp.length).toBeLessThan(20);
  });

  it("downloads a bucket gained while offline on reconnect", async () => {
    const admin = new RoomAdmin();
    const [alice, carol] = await Promise.all([person("Alice"), person("Carol")]);
    const room1 = await admin.createRoom("room 1", [alice.userId]);
    await admin.post(room1, "one", "two", "three");
    const carolSees = await watchMessages(carol);

    carol.device.goOffline();
    await admin.addMember(room1, carol.userId);
    await say(alice, room1, "four");
    carol.device.goOnline();

    await waitFor(() => carolSees.length === 4);
    expect(texts(carolSees)).toEqual(["four", "one", "three", "two"]);
    await carol.store.caughtUp();
    expect(carol.store.getAll(Room).map((room) => room.name)).toEqual(["room 1"]);
  });

  it("removes a bucket lost while offline on reconnect", async () => {
    const admin = new RoomAdmin();
    const [alice, carol] = await Promise.all([person("Alice"), person("Carol")]);
    const room1 = await admin.createRoom("room 1", [alice.userId, carol.userId]);
    await admin.post(room1, "one", "two", "three");
    const carolSees = await watchMessages(carol);
    await waitFor(() => carolSees.length === 3);

    carol.device.goOffline();
    await admin.removeMember(room1, carol.userId);
    await say(alice, room1, "four");
    carol.device.goOnline();

    await waitFor(() => carolSees.length === 0);
    await carol.store.caughtUp();
    expect(carol.store.getAll(Room)).toEqual([]);
    expect(carol.store.getAll(RoomMessage)).toEqual([]);
  });

  it("resumes from its stored cursors when reopened", async () => {
    const admin = new RoomAdmin();
    const [alice, bob] = await Promise.all([person("Alice"), person("Bob")]);
    const room1 = await admin.createRoom("room 1", [alice.userId, bob.userId]);
    await admin.post(room1, "one", "two", "three");
    const bobSees = await watchMessages(bob);
    await waitFor(() => bobSees.length === 3);

    const reopened = bob.device.reopen();
    await say(alice, room1, "four");
    await say(alice, room1, "five");
    const seenAfterReopen = await watchMessages({ ...bob, device: reopened, store: reopened.store() });

    await waitFor(() => seenAfterReopen.length === 5);
    expect(mentions(reopened.receivedFrames, "four")).toBe(true);
    expect(mentions(reopened.receivedFrames, "one")).toBe(false);
  });

  it("re-downloads a model whose read policy changed", async () => {
    const admin = new RoomAdmin();
    const [alice, carol] = await Promise.all([person("Alice"), person("Carol")]);
    const room1 = await admin.createRoom("room 1", [alice.userId, carol.userId], alice.userId);
    await admin.post(room1, "one", "two", "three");
    const aliceSees = await watchMessages(alice);
    const carolSees = await watchMessages(carol);
    await waitFor(() => aliceSees.length === 3 && carolSees.length === 3);

    alice.device.goOffline();
    carol.device.goOffline();
    await redeployServer(tightenedSchema);
    alice.device.goOnline();
    carol.device.goOnline();

    await waitFor(() => carolSees.length === 0);
    await carol.store.caughtUp();
    expect(carol.store.getAll(RoomMessage)).toEqual([]);
    await wait(SETTLE_MS);
    expect(texts(aliceSees)).toEqual(["one", "three", "two"]);
  });
});
