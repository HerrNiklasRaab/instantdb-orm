import { describe, expect, it } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { Room } from "../support/entities/Room";
import { RoomMember } from "../support/entities/RoomMember";
import { connectTestClient, id, registerIdentity, waitFor } from "./support/clients";
import { Device } from "./support/Device";

describe("Withheld fields", () => {
  // rooms.inviteCode is required, and only the creator may read it.
  it("replicates a row to a reader the server withholds a required field from", async () => {
    const email = `bob-${id()}@example.com`;
    const bobId = registerIdentity(email);
    const admin = new RootStore({ client: connectTestClient() });
    const room = await admin.transaction(() => {
      const created = new Room("book club", `creator-${id()}`);
      created.members.push(new RoomMember(bobId, created));
      return created;
    });
    const bob = (await Device.open(email)).store();

    const seen: Room[] = [];
    await bob.subscribeModel(Room, (rooms) => { seen.splice(0, seen.length, ...rooms); });

    await waitFor(() => seen.some((candidate) => candidate.id === room.id));
    expect(seen.find((candidate) => candidate.id === room.id)?.name).toBe("book club");
  });
});
