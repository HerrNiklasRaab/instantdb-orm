import { makeObservable as mobxMakeObservable, observable } from "mobx";
import { Model, model, field, Temporal } from "../../../src/object-graph";
import { DateRange } from "./temporalValueObjects";

@model("appointments")
export class Appointment extends Model {
  @field({ type: Temporal.Instant })
  scheduledFor: Temporal.Instant;

  @field({ type: Temporal.PlainDate, optional: true })
  day: Temporal.PlainDate | null = null;

  @field({ type: Temporal.PlainTime, optional: true })
  startTime: Temporal.PlainTime | null = null;

  @field({ type: Temporal.PlainDateTime, optional: true })
  localStart: Temporal.PlainDateTime | null = null;

  @field({ type: Temporal.PlainYearMonth, optional: true })
  billingMonth: Temporal.PlainYearMonth | null = null;

  @field({ type: Temporal.PlainMonthDay, optional: true })
  anniversary: Temporal.PlainMonthDay | null = null;

  @field({ type: Temporal.ZonedDateTime, attributeName: "zonedStart", optional: true })
  zonedStart: Temporal.ZonedDateTime | null = null;

  @field({ type: Temporal.Duration, optional: true })
  duration: Temporal.Duration | null = null;

  @field({ type: DateRange, attributeName: "vacation", optional: true })
  vacation: DateRange | null = null;

  protected override makeObservable(): void {
    super.makeObservable();
    mobxMakeObservable(this, {
      scheduledFor: observable.ref,
      day: observable.ref,
      startTime: observable.ref,
      localStart: observable.ref,
      billingMonth: observable.ref,
      anniversary: observable.ref,
      zonedStart: observable.ref,
      duration: observable.ref,
      vacation: observable.ref,
    });
  }

  constructor(scheduledFor: Temporal.Instant, id?: string) {
    super(id);
    this.scheduledFor = scheduledFor;
    this.initTracking();
  }
}
