import { Model } from "../../src/object-graph";
import type { User } from "./User";

// Abstract base - NOT decorated with @model (children are)
export abstract class MatchRequest extends Model {
  readonly id: string;
  abstract readonly type: string; // discriminator

  private _createdAt: Date;
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

  constructor(id: string, data: { createdAt: Date }) {
    super();
    this.id = id;
    this._createdAt = data.createdAt;
  }
}
