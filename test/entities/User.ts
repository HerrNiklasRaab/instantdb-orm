import { makeObservable, observable } from "mobx";
import { Model, model } from "../../src/object-graph";
import type { Profile } from "./Profile";
import type { Post } from "./Post";
import type { MatchRequest } from "./MatchRequest";
import type { ChessMatch } from "./ChessMatch";
import type { SkiMatch } from "./SkiMatch";

@model
export class User extends Model {
  // Private backing fields (ORM reads/writes these directly)
  private _name: string;
  private _createdAt: Date;
  private _updatedAt: Date;
  private _deletedAt: Date | null = null;

  // Public getters/setters for API convenience
  get name(): string {
    return this._name;
  }
  set name(value: string) {
    this._name = value;
  }

  get createdAt(): Date {
    return this._createdAt;
  }
  set createdAt(value: Date) {
    this._createdAt = value;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }
  set updatedAt(value: Date) {
    this._updatedAt = value;
  }

  get deletedAt(): Date | null {
    return this._deletedAt;
  }
  set deletedAt(value: Date | null) {
    this._deletedAt = value;
  }

  // Relationships - mix of public and private backing fields
  profile: Profile | null = null;  // public to-one
  referredBy: User | null = null;  // public to-one
  referrals: User[] = [];          // public to-many
  matchRequests: MatchRequest[] = [];  // STI: reverse of matchRequests.requester
  chessMatchs: ChessMatch[] = [];      // MTI: reverse of chessMatchs.requester
  skiMatchs: SkiMatch[] = [];          // MTI: reverse of skiMatchs.requester

  // Private backing field for to-many relationship
  private _posts: Post[] = [];

  get posts(): Post[] {
    return this._posts;
  }
  set posts(value: Post[]) {
    this._posts = value;
  }

  constructor(data: { name: string; createdAt: Date; updatedAt: Date }, id?: string) {
    super(id);
    this._name = data.name;
    this._createdAt = data.createdAt;
    this._updatedAt = data.updatedAt;
    makeObservable(this, {
      _name: observable,
      _createdAt: observable,
      _updatedAt: observable,
      _deletedAt: observable,
      profile: observable.ref,
      _posts: observable.shallow,
      referredBy: observable.ref,
      referrals: observable.shallow,
      matchRequests: observable.shallow,
      chessMatchs: observable.shallow,
      skiMatchs: observable.shallow,
    } as any);
  }
}
