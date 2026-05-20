import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model, model, field } from "../../../src/object-graph";
import type { UserProfile } from "./Profile";
import type { Post } from "./Post";
import type { Invitation } from "./Invitation";
import type { ChessInvitation } from "./ChessInvitation";
import type { ChessMatch } from "./ChessMatch";
import type { SkiMatch } from "./SkiMatch";

export type UserStatus = "active" | "inactive" | "pending";

export enum UserRole {
  Admin = "admin",
  Member = "member",
  Guest = "guest",
}

@model
export class User extends Model {
  // Required field (set in constructor)
  @field()
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

  // Permission-restricted field - may not be returned due to permissions
  secretField: string | undefined = undefined;

  // Enum fields - string literal union and TypeScript native enum
  status: UserStatus | null = null;
  role: UserRole | null = null;

  // Relationships - mix of public and private backing fields
  profile: UserProfile | null = null;  // public to-one
  referredBy: User | null = null;  // public to-one
  referrals: User[] = [];          // public to-many
  invitations: Invitation[] = [];  // STI: reverse of invitations.inviter
  // Reverse of `invitations.opponent`, declared only on ChessInvitation.
  // Used by the STI per-subclass relationship tests.
  opponentInvitation: ChessInvitation | null = null;
  chessMatchs: ChessMatch[] = [];      // MTI: reverse of chessMatchs.inviter
  skiMatchs: SkiMatch[] = [];          // MTI: reverse of skiMatchs.inviter

  // Private backing field for to-many relationship
  @field()
  private _posts: Post[] = [];

  get posts(): Post[] {
    return this._posts;
  }
  set posts(value: Post[]) {
    this._posts = value;
  }

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable<User, "_name" | "_posts">(this, {
      _name: observable,
      testDate: observable,
      secretField: observable,
      status: observable,
      role: observable,
      profile: observable.ref,
      _posts: observable.shallow,
      referredBy: observable.ref,
      referrals: observable.shallow,
      invitations: observable.shallow,
      opponentInvitation: observable.ref,
      chessMatchs: observable.shallow,
      skiMatchs: observable.shallow,
    });
  }

  constructor(name: string, id?: string) {
    super(id);
    this._name = name;
    this.initTracking();
  }
}
