import { makeObservable, observable } from "mobx";
import { Model } from "../../src/object-graph";
import type { User } from "./User";

// Abstract base for MTI - NOT decorated with @model (concrete children are)
// Unlike STI's MatchRequest, this has NO type discriminator
export abstract class Match extends Model {

  // Relationship to User (requester)
  requester: User | null = null;

  constructor(data: Record<string, never> = {}, id?: string) {
    super(id);
    makeObservable(this, {
      createdAt: observable,
      updatedAt: observable,
      deletedAt: observable,
      requester: observable.ref,
    } as any);
  }
}
