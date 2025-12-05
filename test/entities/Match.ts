import { Model } from "../../src/object-graph";
import type { User } from "./User";

// Abstract base for MTI - NOT decorated with @model (concrete children are)
// Unlike STI's MatchRequest, this has NO type discriminator
export abstract class Match extends Model {

  declare private _createdAt: Date;
  private _deletedAt: Date | null = null;

  // Relationship to User (requester)
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
  }
}
