import { makeObservable, observable } from "mobx";
import { Model, model } from "../../src/object-graph";
import type { Profile } from "./Profile";
import type { Post } from "./Post";

@model
export class User extends Model {
  readonly id: string;

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

  // Private backing field for to-many relationship
  private _posts: Post[] = [];

  get posts(): Post[] {
    return this._posts;
  }
  set posts(value: Post[]) {
    this._posts = value;
  }

  constructor(id: string, name: string, createdAt: Date, updatedAt: Date) {
    super();
    this.id = id;
    this._name = name;
    this._createdAt = createdAt;
    this._updatedAt = updatedAt;
    makeObservable<User, "_name" | "_createdAt" | "_updatedAt" | "_deletedAt" | "_posts">(this, {
      _name: observable,
      _createdAt: observable,
      _updatedAt: observable,
      _deletedAt: observable,
      profile: observable.ref,
      _posts: observable.shallow,
      referredBy: observable.ref,
      referrals: observable.shallow,
    });
    this._initTracker();
  }
}
