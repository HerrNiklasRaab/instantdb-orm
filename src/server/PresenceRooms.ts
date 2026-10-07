import type { JsonValue } from "@zenstackhq/orm";
import type { PresencePeer, PresenceRoomRef } from "../protocol";

/** Someone in a presence room, as the rooms see them: who they are, and how to tell them who else is there. */
export interface PresenceOccupant {
  readonly userId: string | null;
  hearPresence(room: PresenceRoomRef, peers: PresencePeer[]): void;
}

function keyOf(room: PresenceRoomRef): string {
  return `${room.entity}/${room.id}`;
}

/**
 * Who is in each row's presence room, and with what state. Lives in memory
 * only: nothing here is written anywhere, and it is gone with the process.
 * Whether someone may be in a room is decided before they get here.
 */
export class PresenceRooms {
  private readonly rooms = new Map<string, { ref: PresenceRoomRef; occupants: Map<PresenceOccupant, JsonValue | null> }>();

  /** Enters `room`, or updates the state there; everyone in it hears the new picture. */
  set(room: PresenceRoomRef, occupant: PresenceOccupant, state: JsonValue | null): void {
    const key = keyOf(room);
    const entry = this.rooms.get(key) ?? { ref: room, occupants: new Map<PresenceOccupant, JsonValue | null>() };
    this.rooms.set(key, entry);
    entry.occupants.set(occupant, state);
    this.tellEveryoneIn(key);
  }

  leave(room: PresenceRoomRef, occupant: PresenceOccupant): void {
    const key = keyOf(room);
    const entry = this.rooms.get(key);
    if (!entry?.occupants.delete(occupant)) return;
    if (entry.occupants.size === 0) this.rooms.delete(key);
    else this.tellEveryoneIn(key);
  }

  leaveAll(occupant: PresenceOccupant): void {
    for (const room of this.roomsOf(occupant)) this.leave(room, occupant);
  }

  roomsOf(occupant: PresenceOccupant): PresenceRoomRef[] {
    return [...this.rooms.values()].filter((entry) => entry.occupants.has(occupant)).map((entry) => entry.ref);
  }

  private tellEveryoneIn(key: string): void {
    const entry = this.rooms.get(key);
    if (!entry) return;
    for (const listener of entry.occupants.keys()) {
      const peers = [...entry.occupants]
        .filter(([other]) => other !== listener)
        .map(([other, state]) => ({ userId: other.userId, state }));
      listener.hearPresence(entry.ref, peers);
    }
  }
}
