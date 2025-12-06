import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model, model } from "../../src/object-graph";
import type { User } from "./User";

@model
export class Post extends Model {
  // Required field (set in constructor)
  title: string;

  // Optional field (schema has .optional())
  content: string | null = null;

  // Relationships
  author: User | null = null;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      title: observable,
      content: observable,
      author: observable.ref,
    });
  }

  constructor(data: { id?: string; title: string; author?: User }) {
    super({ id: data.id });
    this.title = data.title;
    if (data.author) {
      this.author = data.author;  // Set relationship IN constructor
    }
    this.initTracking();
  }
}
