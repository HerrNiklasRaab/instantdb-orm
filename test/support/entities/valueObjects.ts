import { field, valueObject, ValueObject } from "../../../src/object-graph";

@valueObject()
export class Money extends ValueObject {
  readonly amount: number;
  readonly currency: string;

  constructor(amount: number, currency: string) {
    super();
    if (amount < 0) throw new Error("Money.amount must be >= 0");
    this.amount = amount;
    this.currency = currency;
    Object.freeze(this);
  }

  withAmount(amount: number): Money {
    return new Money(amount, this.currency);
  }
  withCurrency(currency: string): Money {
    return new Money(this.amount, currency);
  }
}

@valueObject()
export class LocalTime extends ValueObject {
  readonly hour: number;
  readonly minute: number;

  constructor(hour: number, minute: number) {
    super();
    this.hour = hour;
    this.minute = minute;
    Object.freeze(this);
  }
}

@valueObject()
export class TimeRange extends ValueObject {
  @field({ type: LocalTime })
  readonly start: LocalTime;

  @field({ type: LocalTime })
  readonly end: LocalTime;

  constructor(start: LocalTime, end: LocalTime) {
    super();
    this.start = start;
    this.end = end;
    Object.freeze(this);
  }
}

@valueObject()
export class Price extends ValueObject {
  readonly amount: number;

  @field({ optional: true })
  readonly discount: number | null;

  constructor(amount: number, discount: number | null) {
    super();
    this.amount = amount;
    this.discount = discount;
    Object.freeze(this);
  }
}

@valueObject({ json: true })
export class Tags extends ValueObject {
  readonly items: readonly string[];

  constructor(items: readonly string[]) {
    super();
    this.items = [...items];
    Object.freeze(this);
  }
}

@valueObject({ json: true })
export class WeirdEqMoney extends ValueObject {
  readonly amount: number;
  readonly currency: string;

  constructor(amount: number, currency: string) {
    super();
    this.amount = amount;
    this.currency = currency;
    Object.freeze(this);
  }

  override equals(other: unknown): boolean {
    return other instanceof WeirdEqMoney && other.currency === this.currency;
  }
}

@valueObject({ json: true })
export class Schedule extends ValueObject {
  @field({ type: TimeRange })
  readonly weekday: TimeRange;

  constructor(weekday: TimeRange) {
    super();
    this.weekday = weekday;
    Object.freeze(this);
  }
}

@valueObject()
export class RemappedMoney extends ValueObject {
  @field({ attributeName: "cents" })
  readonly amount: number;

  readonly currency: string;

  constructor(amount: number, currency: string) {
    super();
    this.amount = amount;
    this.currency = currency;
    Object.freeze(this);
  }
}
