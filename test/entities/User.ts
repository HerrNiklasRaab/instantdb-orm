import { makeObservable, observable } from "mobx";
import { Model } from "../../src/object-graph/Model";
import type { Profile } from "./Profile";
import type { Post } from "./Post";

export class User extends Model {
  readonly id: string;

  name: string = undefined!;
  createdAt: Date = undefined!;
  updatedAt: Date = undefined!;
  deletedAt: Date | null = null;

  // Relationships
  profile: Profile | null = null;
  posts: Post[] = [];
  referredBy: User | null = null;
  referrals: User[] = [];

  constructor(id: string) {
    super();
    this.id = id;
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
    this.initializeTracking();
  }
}
