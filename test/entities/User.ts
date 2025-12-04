import { makeObservable, observable } from "mobx";
import { Model, model } from "../../src/object-graph";
import type { Profile } from "./Profile";
import type { Post } from "./Post";

@model
export class User extends Model {
  readonly id: string;

  // Required fields (passed in constructor)
  name: string;
  createdAt: Date;
  updatedAt: Date;

  // Optional fields (with defaults)
  deletedAt: Date | null = null;

  // Relationships
  profile: Profile | null = null;
  posts: Post[] = [];
  referredBy: User | null = null;
  referrals: User[] = [];

  constructor(id: string, name: string, createdAt: Date, updatedAt: Date) {
    super();
    this.id = id;
    this.name = name;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    makeObservable(this, {
      name: observable,
      createdAt: observable,
      updatedAt: observable,
      deletedAt: observable,
      profile: observable.ref,
      posts: observable.shallow,
      referredBy: observable.ref,
      referrals: observable.shallow,
    });
    this._initTracker();
  }
}
