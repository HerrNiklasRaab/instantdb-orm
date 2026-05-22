import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model, model, field } from "../../../src/object-graph";
import { Money, TimeRange, Price, Tags, Schedule } from "./valueObjects";

@model
export class Listing extends Model {
  @field({ type: Money })
  price: Money;

  @field({ type: Money })
  minBid: Money | null = null;

  @field({ type: TimeRange })
  slot: TimeRange | null = null;

  @field({ type: Price })
  flexPrice: Price | null = null;

  @field({ type: Tags })
  tags: Tags;

  @field({ type: Schedule })
  schedule: Schedule | null = null;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      price: observable.ref,
      minBid: observable.ref,
      slot: observable.ref,
      flexPrice: observable.ref,
      tags: observable.ref,
      schedule: observable.ref,
    });
  }

  constructor(price: Money, tags: Tags, id?: string) {
    super(id);
    this.price = price;
    this.tags = tags;
    this.initTracking();
  }
}
