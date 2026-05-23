import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model, model, field } from "../../../src/object-graph";
import { Money, TimeRange, Price, Tags, Schedule, Slug } from "./valueObjects";

@model
export class Listing extends Model {
  @field({ type: Money })
  price: Money;

  @field({ type: Money, optional: true })
  minBid: Money | null = null;

  @field({ type: TimeRange, optional: true })
  slot: TimeRange | null = null;

  @field({ type: Price, optional: true })
  flexPrice: Price | null = null;

  @field({ type: Tags })
  tags: Tags;

  @field({ type: Schedule, optional: true })
  schedule: Schedule | null = null;

  @field({ type: Slug, optional: true })
  slug: Slug | null = null;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      price: observable.ref,
      minBid: observable.ref,
      slot: observable.ref,
      flexPrice: observable.ref,
      tags: observable.ref,
      schedule: observable.ref,
      slug: observable.ref,
    });
  }

  constructor(price: Money, tags: Tags, id?: string) {
    super(id);
    this.price = price;
    this.tags = tags;
    this.initTracking();
  }
}
