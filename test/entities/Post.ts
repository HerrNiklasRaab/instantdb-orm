import { makeObservable, observable } from "mobx";
import { Model, model } from "../../src/object-graph";
import type { User } from "./User";

@model
export class Post extends Model {
  // Required fields (passed in constructor)
  title: string;

  // Optional fields (with defaults)
  content?: string = undefined;

  // Relationships
  author: User | null = null;

  constructor(data: { title: string; author?: User }, id?: string) {
    super(id);
    this.title = data.title;
    if (data.author) {
      this.author = data.author;  // Set relationship IN constructor
    }
    makeObservable(this, {
      title: observable,
      content: observable,
      author: observable.ref,
    });
    this.initTracking();
  }
}
