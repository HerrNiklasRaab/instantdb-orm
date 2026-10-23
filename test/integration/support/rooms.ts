import { RootStore } from "../../../src/object-graph/store/RootStore";
import { Room } from "../../support/entities/Room";
import { RoomMember } from "../../support/entities/RoomMember";
import { RoomMessage } from "../../support/entities/RoomMessage";
import { assertDefined, connectTestClient, id, registerIdentity, type TestStore } from "./clients";
import { Device } from "./Device";

/** What the admin, standing in for backend code, does to rooms. */
export class RoomAdmin {
  private readonly store: TestStore = new RootStore({ client: connectTestClient() });

  async createRoom(name: string, memberIds: string[], creatorId: string | null = null): Promise<Room> {
    const [room] = await this.store.transaction(() => {
      const created = new Room(name, creatorId);
      for (const userId of memberIds) created.members.push(new RoomMember(userId, created));
      return [created];
    });
    assertDefined(room);
    return room;
  }

  async post(room: Room, ...texts: string[]): Promise<void> {
    await this.store.transaction(() => texts.map((text) => new RoomMessage(text, room)));
  }

  async addMember(room: Room, userId: string): Promise<void> {
    await this.store.transaction(() => new RoomMember(userId, room));
  }

  async removeMember(room: Room, userId: string): Promise<void> {
    await this.store.caughtUp();
    const members = this.store.getAll(RoomMember);
    const member = members.find((candidate) => candidate.userId === userId && candidate.room?.id === room.id);
    assertDefined(member, `no membership of ${userId} in ${room.name}`);
    await this.store.transaction(() => { member.delete(); });
  }
}

export interface Person {
  readonly userId: string;
  readonly device: Device;
  readonly store: TestStore;
}

export async function person(name: string): Promise<Person> {
  const email = `${name.toLowerCase()}-${id()}@example.com`;
  const userId = registerIdentity(email);
  const device = await Device.open(email);
  return { userId, device, store: device.store() };
}

export async function watchMessages(who: Person): Promise<RoomMessage[]> {
  const seen: RoomMessage[] = [];
  await who.store.subscribeModel(RoomMessage, (messages) => {
    seen.splice(0, seen.length, ...messages);
  });
  return seen;
}

export function mentions(frames: string[], text: string): boolean {
  return frames.some((frame) => frame.includes(text));
}
