import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model } from "../../src/object-graph";
import type { User } from "./User";

// Abstract base - NOT decorated with @model (children are)
export abstract class MatchRequest extends Model {
  abstract readonly type: string; // discriminator

  // Relationship to User
  requester: User | null = null;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      requester: observable.ref,
    } as any);
  }

  constructor(data: { id?: string } = {}) {
    super({ id: data.id });
  }
}
