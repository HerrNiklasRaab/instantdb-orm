import type { JsonValue } from "@zenstackhq/orm";
import { makeObservable, observable } from "mobx";
import type { PresencePeer, PresenceRoomRef } from "../protocol";

/** How a presence room reaches the server, through the client it belongs to. */
export interface PresenceChannel {
  send(room: PresenceRoomRef, state: JsonValue | null): void;
  leave(room: PresenceRoom): void;
}

/**
 * This device's place in one row's presence room: its own state, and everyone
 * else's as the server last told it. Observable, so a view follows who is
 * typing. Nothing here is stored; while offline the room is empty, and on
 * reconnect the client enters it again with the last state set.
 */
export class PresenceRoom {
  peers: readonly PresencePeer[] = [];
  /** The device may not, or may no longer, read the room's row. */
  refused = false;
  private state: JsonValue | null = null;
  private open = true;

  constructor(
    readonly ref: PresenceRoomRef,
    private readonly channel: PresenceChannel,
  ) {
    makeObservable(this, { peers: observable.ref, refused: observable });
  }

  /** This device's state in the room for everyone else to see; null is present without one. */
  set(state: JsonValue | null): void {
    this.state = state;
    if (this.open && !this.refused) this.channel.send(this.ref, state);
  }

  /** Lets go of the room; the device leaves it once every holder has. */
  leave(): void {
    if (this.open) this.channel.leave(this);
  }

  /** Enters the room with the last state set; the client calls this on every new connection. */
  enter(): void {
    if (this.open && !this.refused) this.channel.send(this.ref, this.state);
  }

  /** The device has left: nothing sent through this handle reaches the room any more. */
  close(): void {
    this.open = false;
    this.peers = [];
  }

  heard(peers: readonly PresencePeer[]): void {
    this.peers = peers;
  }

  refuse(): void {
    this.refused = true;
    this.peers = [];
  }

  disconnected(): void {
    this.peers = [];
  }
}
