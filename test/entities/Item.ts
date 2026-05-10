import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model, model } from "../../src/object-graph";
import type { Container } from "./Container";

@model
export class Item extends Model {
  name: string;
  container: Container | null = null;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      name: observable,
      container: observable.ref,
    } as any);
  }

  constructor(name: string, container: Container | null = null, id?: string) {
    super(id);
    this.name = name;
    if (container) this.container = container;
    this.initTracking();
  }
}
