import { makeObservable, observable } from "mobx";
import { Model, model } from "../../src/object-graph";
import type { User } from "./User";

@model
export class Profile extends Model {
  readonly id: string;

  bio?: string = undefined;
  avatarUrl?: string = undefined;
  createdAt: Date = undefined!;
  updatedAt: Date = undefined!;
  deletedAt: Date | null = null;

  // Relationships
  user: User | null = null;

  constructor(id: string) {
    super();
    this.id = id;
    makeObservable(this, {
      bio: observable,
      avatarUrl: observable,
      createdAt: observable,
      updatedAt: observable,
      deletedAt: observable,
      user: observable.ref,
    });
    this.initializeTracking();
  }
}
