import { makeObservable, observable } from "mobx";
import { Model, model } from "../../src/object-graph";
import type { User } from "./User";

@model("profiles")
export class UserProfile extends Model {
  // Optional fields (with defaults)
  bio?: string = undefined;
  avatarUrl?: string = undefined;

  // Private backing field for to-one relationship
  private _user: User | null = null;

  get user(): User | null {
    return this._user;
  }
  set user(value: User | null) {
    this._user = value;
  }

  constructor(data: Record<string, never> = {}, id?: string) {
    super(id);
    makeObservable(this, {
      bio: observable,
      avatarUrl: observable,
      _user: observable.ref,
    } as any);
    this.initTracking();
  }
}
