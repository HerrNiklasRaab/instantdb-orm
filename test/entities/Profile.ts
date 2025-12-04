import { makeObservable, observable } from "mobx";
import { Model, model } from "../../src/object-graph";
import type { User } from "./User";

@model
export class Profile extends Model {
  readonly id: string;

  // Required fields (passed in constructor)
  createdAt: Date;
  updatedAt: Date;

  // Optional fields (with defaults)
  bio?: string = undefined;
  avatarUrl?: string = undefined;
  deletedAt: Date | null = null;

  // Private backing field for to-one relationship
  private _user: User | null = null;

  get user(): User | null {
    return this._user;
  }
  set user(value: User | null) {
    this._user = value;
  }

  constructor(id: string, data: { createdAt: Date; updatedAt: Date }) {
    super();
    this.id = id;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
    makeObservable<Profile, "_user">(this, {
      bio: observable,
      avatarUrl: observable,
      createdAt: observable,
      updatedAt: observable,
      deletedAt: observable,
      _user: observable.ref,
    });
    this._initTracker();
  }
}
