import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model, model } from "../../src/object-graph";
import { Item } from "./Item";

/**
 * Test fixture exercising the Party-shaped pattern: a parent constructor
 * that builds child entities inline and passes `this` to them, then also
 * pushes them into its own back-ref array. Used to verify the wirer's
 * mid-construction guard (reverseLinkWiring.ts:21).
 */
@model
export class Container extends Model {
  name: string;
  items: Item[] = [];

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      name: observable,
      items: observable.shallow,
    } as any);
  }

  constructor(name: string, itemNames: string[] = [], id?: string) {
    super(id);
    this.name = name;
    for (const itemName of itemNames) {
      this.items.push(new Item(itemName, this));
    }
    this.initTracking();
  }
}
