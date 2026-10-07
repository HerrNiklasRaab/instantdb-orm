import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model, model } from "../../../src/object-graph";
import type { Room } from "./Room";

@model("roomMembers")
export class RoomMember extends Model {
  userId: string;
  room: Room | null = null;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      userId: observable,
      room: observable.ref,
    });
  }

  constructor(userId: string, room: Room | null = null, id?: string) {
    super(id);
    this.userId = userId;
    if (room) this.room = room;
    this.initTracking();
  }
}
