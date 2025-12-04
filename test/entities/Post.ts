import { makeObservable, observable } from "mobx";
import { Model, model } from "../../src/object-graph";
import type { User } from "./User";

@model
export class Post extends Model {
  readonly id: string;

  title: string = undefined!;
  content?: string = undefined;
  createdAt: Date = undefined!;
  updatedAt: Date = undefined!;
  deletedAt: Date | null = null;

  // Relationships
  author: User | null = null;

  constructor(id: string) {
    super();
    this.id = id;
    makeObservable(this, {
      title: observable,
      content: observable,
      createdAt: observable,
      updatedAt: observable,
      deletedAt: observable,
      author: observable.ref,
    });
    this._initTracker();
  }
}
