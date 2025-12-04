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

  // Relationships
  user: User | null = null;

  constructor(id: string, createdAt: Date, updatedAt: Date) {
    super();
    this.id = id;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    makeObservable(this, {
      bio: observable,
      avatarUrl: observable,
      createdAt: observable,
      updatedAt: observable,
      deletedAt: observable,
      user: observable.ref,
    });
    this._initTracker();
  }
}
