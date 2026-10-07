import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model, model } from "../../../src/object-graph";
import type { Room } from "./Room";

@model("roomMessages")
export class RoomMessage extends Model {
  text: string;
  room: Room | null = null;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      text: observable,
      room: observable.ref,
    });
  }

  constructor(text: string, room: Room | null = null, id?: string) {
    super(id);
    this.text = text;
    if (room) this.room = room;
    this.initTracking();
  }
}
