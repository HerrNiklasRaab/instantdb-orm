import { makeObservable, observable } from "mobx";
import { Model, model } from "../../src/object-graph";
import type { UserProfile } from "./Profile";
import type { Post } from "./Post";
import type { MatchRequest } from "./MatchRequest";
import type { ChessMatch } from "./ChessMatch";
import type { SkiMatch } from "./SkiMatch";

@model
export class User extends Model {
  // Private backing field for name
  private _name: string;

  // Public getters/setters for API convenience
  get name(): string {
    return this._name;
  }
  set name(value: string) {
    this._name = value;
  }

  // Optional test field for testing Date serialization/hydration
  testDate: Date | null = null;

  // Relationships - mix of public and private backing fields
  profile: UserProfile | null = null;  // public to-one
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

  constructor(data: { id?: string; name: string }) {
    super({ id: data.id });
    this._name = data.name;
    makeObservable(this, {
      _name: observable,
      testDate: observable,
      profile: observable.ref,
      _posts: observable.shallow,
      referredBy: observable.ref,
      referrals: observable.shallow,
      matchRequests: observable.shallow,
      chessMatchs: observable.shallow,
      skiMatchs: observable.shallow,
    } as any);
    this.initTracking();
  }
}
