import { field, valueObject, ValueObject, Temporal } from "../../../src/object-graph";

@valueObject()
export class DateRange extends ValueObject {
  @field({ type: Temporal.PlainDate })
  readonly from: Temporal.PlainDate;

  @field({ type: Temporal.PlainDate })
  readonly to: Temporal.PlainDate;

  constructor(from: Temporal.PlainDate, to: Temporal.PlainDate) {
    super();
    if (Temporal.PlainDate.compare(from, to) > 0) {
      throw new Error("DateRange.from must be <= to");
    }
    this.from = from;
    this.to = to;
    Object.freeze(this);
  }

  override toString(): string {
    return `${this.from.toString()}/${this.to.toString()}`;
  }
}
