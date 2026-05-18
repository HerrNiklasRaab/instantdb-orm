import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model, model } from "../../../src/object-graph";
import type { Post } from "./Post";

@model
export class Tag extends Model {
  name: string;

  posts: Post[] = [];

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      name: observable,
      posts: observable.shallow,
    });
  }

  constructor(name: string, id?: string) {
    super(id);
    this.name = name;
    this.initTracking();
  }
}
