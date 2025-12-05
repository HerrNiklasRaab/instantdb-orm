import { makeObservable, observable } from "mobx";
import { Model } from "../../src/object-graph";
import type { User } from "./User";

// Abstract base - NOT decorated with @model (children are)
export abstract class MatchRequest extends Model {
  abstract readonly type: string; // discriminator

  // Relationship to User
  requester: User | null = null;

  constructor(data: Record<string, never> = {}, id?: string) {
    super(id);
    makeObservable(this, {
      requester: observable.ref,
    } as any);
  }
}
