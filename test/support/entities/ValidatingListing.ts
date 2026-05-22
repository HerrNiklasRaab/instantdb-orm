import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model, model, field } from "../../../src/object-graph";
import { Money, TimeRange } from "./valueObjects";

@model
export class ValidatingListing extends Model {
  @field({ type: Money })
  price: Money;

  @field({ type: TimeRange, optional: true })
  slot: TimeRange | null = null;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      price: observable.ref,
      slot: observable.ref,
    });
  }

  constructor(price: Money | undefined, id?: string) {
    super(id);
    if (price === undefined) {
      throw new Error("ValidatingListing requires a price");
    }
    this.price = price;
    this.initTracking();
  }
}
