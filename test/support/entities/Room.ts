import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model, model } from "../../../src/object-graph";
import type { RoomMember } from "./RoomMember";
import type { RoomMessage } from "./RoomMessage";

@model("rooms")
export class Room extends Model {
  name: string;
  creatorId: string | null = null;
  // Withheld from everyone but the creator.
  inviteCode: string | undefined = "";
  members: RoomMember[] = [];
  messages: RoomMessage[] = [];

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      name: observable,
      creatorId: observable,
      inviteCode: observable,
      members: observable.shallow,
      messages: observable.shallow,
    });
  }

  constructor(name: string, creatorId: string | null = null, id?: string) {
    super(id);
    this.name = name;
    this.creatorId = creatorId;
    this.initTracking();
  }
}
