import { describe, expect, it } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { Post } from "../support/entities/Post";
import { Room } from "../support/entities/Room";
import { RoomMember } from "../support/entities/RoomMember";
import { RoomMessage } from "../support/entities/RoomMessage";
import { connectTestClient, id, registerIdentity, waitFor } from "./support/clients";
import { PausableSqlite } from "./support/PausableSqlite";
import { Device } from "./support/Device";


describe("An incoming transaction", () => {
  // A room is visible to its members, and so is everything in it: being added
  // to a room gives the member the room's messages in the same transaction.
  it("arrives together with the buckets it grants", async () => {
    const email = `alice-${id()}@example.com`;
    const aliceId = registerIdentity(email);
    const admin = new RootStore({ client: connectTestClient() });
    const room = await admin.transaction(() => new Room("book club", null));
    await admin.transaction(() => ["one", "two", "three"].map((text) => new RoomMessage(text, room)));
    const alice = (await Device.open(email)).store();
    const snapshots: { member: boolean; messages: number }[] = [];
    await alice.subscribeQueryIsolated({ roomMembers: {}, roomMessages: {} }, (curr) => {
      snapshots.push({
        member: curr.getAll(RoomMember).some((member) => member.userId === aliceId),
        messages: curr.getAll(RoomMessage).length,
      });
      return Promise.resolve();
    });

    await admin.transaction(() => new RoomMember(aliceId, room)).settled();

    await waitFor(() => snapshots.some((snapshot) => snapshot.member && snapshot.messages === 3));
    expect(snapshots.filter((snapshot) => snapshot.member && snapshot.messages < 3)).toEqual([]);
  });

  // Each incoming row is its own SQLite statement; the device pauses with
  // one post written and the database idle, which is when a read could slip
  // in. Offline, the read answers from the device alone.
  it("is not seen by a read until it is written in full", async () => {
    const batch = `batch-${id()}`;
    const sqlite = new PausableSqlite();
    const device = await Device.open(undefined, { sqlite });
    const reader = device.store();
    await reader.queryModel(Post);
    const writer = new RootStore({ client: connectTestClient() });
    const halfway = sqlite.pauseAfterFirstWriteTo("posts");

    await writer.transaction(() => [new Post(`${batch}-first`), new Post(`${batch}-second`)]).settled();
    await halfway;
    device.goOffline();
    const read = reader.query({ posts: { where: { title: { startsWith: batch } } } });
    sqlite.resume();
    await read;

    expect(reader.getAll(Post).filter((post) => post.title.startsWith(batch))).toHaveLength(2);
  });
});
