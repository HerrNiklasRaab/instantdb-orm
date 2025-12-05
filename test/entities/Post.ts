import { makeObservable, observable } from "mobx";
import { Model, model } from "../../src/object-graph";
import type { User } from "./User";

@model
export class Post extends Model {
  // Required fields (passed in constructor)
  title: string;
  createdAt: Date;
  updatedAt: Date;

  // Optional fields (with defaults)
  content?: string = undefined;
  deletedAt: Date | null = null;

  // Relationships
  author: User | null = null;

  constructor(data: { title: string; createdAt: Date; updatedAt: Date }, id?: string) {
    super(id);
    this.title = data.title;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
    makeObservable(this, {
      title: observable,
      content: observable,
      createdAt: observable,
      updatedAt: observable,
      deletedAt: observable,
      author: observable.ref,
    });
    this.initTracking();
  }
}
