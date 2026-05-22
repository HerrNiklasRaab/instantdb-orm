import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model, model, field } from "../../../src/object-graph";
import { RemappedMoney } from "./valueObjects";

@model
export class RemappedListing extends Model {
  @field({ type: RemappedMoney })
  price: RemappedMoney;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, { price: observable.ref });
  }

  constructor(price: RemappedMoney, id?: string) {
    super(id);
    this.price = price;
    this.initTracking();
  }
}
