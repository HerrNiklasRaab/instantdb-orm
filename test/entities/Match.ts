import { makeObservable, observable } from "mobx";
import { Model } from "../../src/object-graph";
import type { User } from "./User";

// Abstract base for MTI - NOT decorated with @model (concrete children are)
// Unlike STI's MatchRequest, this has NO type discriminator
export abstract class Match extends Model {

  // Relationship to User (requester)
  requester: User | null = null;

  constructor(data: { id?: string } = {}) {
    super({ id: data.id });
    makeObservable(this, {
      requester: observable.ref,
    } as any);
  }
}
