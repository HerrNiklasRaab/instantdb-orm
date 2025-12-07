import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model, model, field } from "../../src/object-graph";
import type { User } from "./User";

@model("profiles")
export class UserProfile extends Model {
  // Optional fields (schema has .optional())
  bio: string | null = null;
  avatarUrl: string | null = null;

  // Private backing field for to-one relationship
  @field()
  private _user: User | null = null;

  get user(): User | null {
    return this._user;
  }
  set user(value: User | null) {
    this._user = value;
  }

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      bio: observable,
      avatarUrl: observable,
      _user: observable.ref,
    } as any);
  }

  constructor(id?: string) {
    super(id);
    this.initTracking();
  }
}
