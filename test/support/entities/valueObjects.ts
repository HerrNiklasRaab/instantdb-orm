import { field, valueObject, ValueObject, ValueObjectStorage } from "../../../src/object-graph";

@valueObject()
export class Money extends ValueObject {
  @field() readonly amount: number;
  @field() readonly currency: string;

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

  override toString(): string {
    return `${this.amount} ${this.currency}`;
  }
}

@valueObject()
export class LocalTime extends ValueObject {
  @field() readonly hour: number;
  @field() readonly minute: number;

  constructor(hour: number, minute: number) {
    super();
    this.hour = hour;
    this.minute = minute;
    Object.freeze(this);
  }

  override toString(): string {
    return `${String(this.hour).padStart(2, "0")}:${String(this.minute).padStart(2, "0")}`;
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

  override toString(): string {
    return `${this.start.toString()}-${this.end.toString()}`;
  }
}

@valueObject()
export class Price extends ValueObject {
  @field() readonly amount: number;

  @field({ optional: true })
  readonly discount: number | null;

  constructor(amount: number, discount: number | null) {
    super();
    this.amount = amount;
    this.discount = discount;
    Object.freeze(this);
  }

  override toString(): string {
    return this.discount === null ? `${this.amount}` : `${this.amount} (-${this.discount})`;
  }
}

@valueObject({ storage: ValueObjectStorage.Json })
export class Tags extends ValueObject {
  @field() readonly items: readonly string[];

  constructor(items: readonly string[]) {
    super();
    this.items = [...items];
    Object.freeze(this);
  }

  override toString(): string {
    return this.items.join(",");
  }
}

@valueObject({ storage: ValueObjectStorage.Json })
export class WeirdEqMoney extends ValueObject {
  @field() readonly amount: number;
  @field() readonly currency: string;

  constructor(amount: number, currency: string) {
    super();
    this.amount = amount;
    this.currency = currency;
    Object.freeze(this);
  }

  override equals(other: unknown): boolean {
    return other instanceof WeirdEqMoney && other.currency === this.currency;
  }

  override toString(): string {
    return `${this.amount} ${this.currency}`;
  }
}

@valueObject({ storage: ValueObjectStorage.Json })
export class Schedule extends ValueObject {
  @field({ type: TimeRange })
  readonly weekday: TimeRange;

  constructor(weekday: TimeRange) {
    super();
    this.weekday = weekday;
    Object.freeze(this);
  }

  override toString(): string {
    return this.weekday.toString();
  }
}

@valueObject({ storage: ValueObjectStorage.SingleColumn })
export class Slug extends ValueObject {
  @field() readonly value: string;

  constructor(value: string) {
    super();
    if (!value.trim()) throw new Error("Slug cannot be empty");
    this.value = value;
    Object.freeze(this);
  }

  override toString(): string {
    return this.value;
  }
}

@valueObject()
export class RemappedMoney extends ValueObject {
  @field({ attributeName: "cents" })
  readonly amount: number;

  @field() readonly currency: string;

  constructor(amount: number, currency: string) {
    super();
    this.amount = amount;
    this.currency = currency;
    Object.freeze(this);
  }

  override toString(): string {
    return `${this.amount} ${this.currency}`;
  }
}
