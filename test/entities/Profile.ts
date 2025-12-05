import { observable } from "mobx";
import { Model, model } from "../../src/object-graph";
import type { User } from "./User";

@model
export class Profile extends Model {
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

  constructor(data: { createdAt: Date; updatedAt: Date }, id?: string) {
    super(id);
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
    this.init({
      bio: observable,
      avatarUrl: observable,
      createdAt: observable,
      updatedAt: observable,
      deletedAt: observable,
      _user: observable.ref,
    });
  }
}
