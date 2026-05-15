import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model } from "../../../src/object-graph";
import type { User } from "./User";

// Abstract base - NOT decorated with @model (children are)
export abstract class Invitation extends Model {
  abstract readonly modelType: string; // discriminator

  // Relationship to User
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
