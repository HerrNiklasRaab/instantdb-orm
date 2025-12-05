import { makeObservable, observable } from "mobx";
import { Model } from "../../src/object-graph";
import type { User } from "./User";

// Abstract base - NOT decorated with @model (children are)
export abstract class MatchRequest extends Model {
  abstract readonly type: string; // discriminator

  declare private _createdAt: Date;
  private _deletedAt: Date | null = null;

  // Relationship to User
  requester: User | null = null;

  get createdAt(): Date {
    return this._createdAt;
  }
  set createdAt(value: Date) {
    this._createdAt = value;
  }

  get deletedAt(): Date | null {
    return this._deletedAt;
  }
  set deletedAt(value: Date | null) {
    this._deletedAt = value;
  }

  constructor(data: { createdAt: Date }, id?: string) {
    super(id);
    this._createdAt = data.createdAt;
    makeObservable(this, {
      _createdAt: observable,
      _deletedAt: observable,
      requester: observable.ref,
    } as any);
  }
}
