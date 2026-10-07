import { describe, expect, it } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { Room } from "../support/entities/Room";
import { RoomMember } from "../support/entities/RoomMember";
import { connectTestClient, id, registerIdentity, waitFor, type TestStore } from "./support/clients";
import { Device } from "./support/Device";

interface Person {
  readonly id: string;
  readonly device: Device;
  readonly store: TestStore;
}

async function person(): Promise<Person> {
  const email = `person-${id()}@example.com`;
  const device = await Device.open(email);
  return { id: registerIdentity(email), device, store: device.store() };
}

/** A room whose members are exactly `members`, committed on the server before anyone joins its presence. */
async function roomOf(...members: Person[]): Promise<{ room: Room; admin: TestStore; memberships: RoomMember[] }> {
  const admin = new RootStore({ client: connectTestClient() });
  const room = await admin.transaction(() => new Room(`room-${id()}`, null));
  const { result: memberships } = await admin
    .transaction(() => members.map((member) => new RoomMember(member.id, room)))
    .settled();
  return { room, admin, memberships };
}

function typing(state: unknown): boolean {
  return typeof state === "object" && state !== null && Reflect.get(state, "typing") === true;
}

describe("Presence", () => {
  it("reaches everyone else in the room", async () => {
    const alice = await person();
    const bob = await person();
    const { room } = await roomOf(alice, bob);
    const alicePresence = alice.store.presence(Room, room.id);
    const bobPresence = bob.store.presence(Room, room.id);

    alicePresence.set({ typing: true });

    await waitFor(() => bobPresence.peers.some((peer) => peer.userId === alice.id && typing(peer.state)));
    await waitFor(() => alicePresence.peers.some((peer) => peer.userId === bob.id));
    expect(alicePresence.peers.map((peer) => peer.userId)).toEqual([bob.id]);
  });

  // Dave seeing Alice's state proves the server holds it before Bob asks;
  // Alice sends nothing afterwards, so Bob can only learn it on joining.
  it("shows a newcomer the state already there", async () => {
    const alice = await person();
    const bob = await person();
    const dave = await person();
    const { room } = await roomOf(alice, bob, dave);
    const alicePresence = alice.store.presence(Room, room.id);
    const davePresence = dave.store.presence(Room, room.id);
    alicePresence.set({ typing: true });
    await waitFor(() => davePresence.peers.some((peer) => peer.userId === alice.id && typing(peer.state)));

    const bobPresence = bob.store.presence(Room, room.id);

    await waitFor(() => bobPresence.peers.some((peer) => peer.userId === alice.id && typing(peer.state)));
  });

  it("is only shared with whoever may read the row", async () => {
    const alice = await person();
    const bob = await person();
    const carol = await person();
    const { room } = await roomOf(alice, bob);
    const alicePresence = alice.store.presence(Room, room.id);
    const bobPresence = bob.store.presence(Room, room.id);
    const carolPresence = carol.store.presence(Room, room.id);
    await waitFor(() => carolPresence.refused);

    alicePresence.set({ typing: true });

    await waitFor(() => bobPresence.peers.some((peer) => peer.userId === alice.id && typing(peer.state)));
    expect(carolPresence.peers).toEqual([]);
    expect(alicePresence.peers.map((peer) => peer.userId)).toEqual([bob.id]);
  });

  it("is withdrawn when the device leaves", async () => {
    const alice = await person();
    const bob = await person();
    const { room } = await roomOf(alice, bob);
    const alicePresence = alice.store.presence(Room, room.id);
    const bobPresence = bob.store.presence(Room, room.id);
    await waitFor(() => alicePresence.peers.some((peer) => peer.userId === bob.id));

    bobPresence.leave();

    await waitFor(() => alicePresence.peers.every((peer) => peer.userId !== bob.id));
  });

  it("is withdrawn when the connection drops", async () => {
    const alice = await person();
    const bob = await person();
    const { room } = await roomOf(alice, bob);
    const alicePresence = alice.store.presence(Room, room.id);
    bob.store.presence(Room, room.id);
    await waitFor(() => alicePresence.peers.some((peer) => peer.userId === bob.id));

    bob.device.goOffline();

    await waitFor(() => alicePresence.peers.every((peer) => peer.userId !== bob.id));
  });

  it("is restored after a reconnect", async () => {
    const alice = await person();
    const bob = await person();
    const { room } = await roomOf(alice, bob);
    const alicePresence = alice.store.presence(Room, room.id);
    const bobPresence = bob.store.presence(Room, room.id);
    bobPresence.set({ typing: true });
    await waitFor(() => alicePresence.peers.some((peer) => peer.userId === bob.id && typing(peer.state)));
    bob.device.goOffline();
    await waitFor(() => alicePresence.peers.every((peer) => peer.userId !== bob.id));
    alicePresence.set({ typing: true });

    bob.device.goOnline();

    await waitFor(() => alicePresence.peers.some((peer) => peer.userId === bob.id && typing(peer.state)));
    await waitFor(() => bobPresence.peers.some((peer) => peer.userId === alice.id && typing(peer.state)));
  });

  it("withdraws a state set to null", async () => {
    const alice = await person();
    const bob = await person();
    const { room } = await roomOf(alice, bob);
    const alicePresence = alice.store.presence(Room, room.id);
    const bobPresence = bob.store.presence(Room, room.id);
    alicePresence.set({ typing: true });
    await waitFor(() => bobPresence.peers.some((peer) => peer.userId === alice.id && typing(peer.state)));

    alicePresence.set(null);

    await waitFor(() => bobPresence.peers.some((peer) => peer.userId === alice.id && peer.state === null));
  });

  // Dave seeing Alice's later state proves it went out; Bob, no longer a
  // member, must not have received it.
  it("ends when access to the row ends", async () => {
    const alice = await person();
    const bob = await person();
    const dave = await person();
    const { room, admin, memberships } = await roomOf(alice, bob, dave);
    const alicePresence = alice.store.presence(Room, room.id);
    const bobPresence = bob.store.presence(Room, room.id);
    const davePresence = dave.store.presence(Room, room.id);
    await waitFor(() => alicePresence.peers.some((peer) => peer.userId === bob.id));
    const bobMembership = memberships.find((membership) => membership.userId === bob.id);
    if (!bobMembership) throw new Error("Bob's membership is missing");

    await admin.transaction(() => { bobMembership.delete(); }).settled();

    await waitFor(() => bobPresence.refused);
    await waitFor(() => alicePresence.peers.every((peer) => peer.userId !== bob.id));
    alicePresence.set({ typing: true });
    await waitFor(() => davePresence.peers.some((peer) => peer.userId === alice.id && typing(peer.state)));
    expect(bobPresence.peers).toEqual([]);
  });
});
