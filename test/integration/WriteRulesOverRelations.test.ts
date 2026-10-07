import { describe, expect, it } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { Transaction, type TransactionOutcome } from "../../src/transactions";
import { Room } from "../support/entities/Room";
import { RoomMember } from "../support/entities/RoomMember";
import { RoomMessage } from "../support/entities/RoomMessage";
import { assertDefined, connectTestClient, id, registerIdentity, waitFor } from "./support/clients";
import { Device } from "./support/Device";

async function roomWith(memberId: string): Promise<Room> {
  const admin = new RootStore({ client: connectTestClient() });
  return admin.transaction(() => {
    const room = new Room("room", null);
    room.members.push(new RoomMember(memberId, room));
    return room;
  });
}

describe("Write rules over relations", () => {
  // roomMessages may be created only by members of the room they are posted to.
  it("lets a member post into their room, the room link being part of the new message", async () => {
    const email = `alice-${id()}@example.com`;
    const room = await roomWith(registerIdentity(email));
    const denials: TransactionOutcome[] = [];
    const alice = (await Device.open(email)).store({ denials });
    const rooms = await alice.queryModel(Room);
    const mine = rooms.find((candidate) => candidate.id === room.id);
    assertDefined(mine);

    const message = await alice.transaction(() => new RoomMessage("hello", mine));

    const admin = new RootStore({ client: connectTestClient() });
    await waitFor(async () => (await admin.queryModel(RoomMessage)).some((stored) => stored.id === message.id));
    expect(denials).toEqual([]);
  });

  it("refuses a post into a room the author is not a member of", async () => {
    const room = await roomWith(registerIdentity(`alice-${id()}@example.com`));
    const mallory = await Device.open(`mallory-${id()}@example.com`);
    const messageId = id();
    const now = new Date().toISOString();

    const outcome = await mallory.client.commit(new Transaction()
      .create("roomMessages", messageId, { text: "let me in", createdAt: now, updatedAt: now }, { room: room.id }));

    expect(outcome.status).toBe("denied");
  });
});
