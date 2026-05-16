import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model } from "../../../src/object-graph";
import type { User } from "./User";

// Abstract base for MTI - NOT decorated with @model (concrete children are)
// Unlike STI's Invitation, this has NO type discriminator
export abstract class Match extends Model {

  // Relationship to User (inviter)
  inviter: User | null = null;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      inviter: observable.ref,
    } as any);
  }

  constructor(id?: string) {
    super(id);
  }
}
