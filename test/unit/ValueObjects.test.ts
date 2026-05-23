import { describe, it, expect, beforeAll } from "vitest";
import { reaction } from "mobx";
import {
  configureEntityMeta,
  valueObject,
  ValueObject,
  ValueObjectStorage,
  field,
} from "../../src/object-graph";
import { withTestTransaction } from "../../src/testing";
import schema from "../support/instant.schema";
import {
  Money,
  LocalTime,
  TimeRange,
  Price,
  Tags,
  WeirdEqMoney,
  Slug,
} from "../support/entities/valueObjects";
import { Listing } from "../support/entities/Listing";

beforeAll(() => {
  configureEntityMeta(schema);
});

describe("ValueObject — equality", () => {
  it("returns true for two VOs with identical field values", () => {
    expect(new Money(50, "EUR").equals(new Money(50, "EUR"))).toBe(true);
  });

  it("returns false when any field differs", () => {
    expect(new Money(50, "EUR").equals(new Money(50, "USD"))).toBe(false);
    expect(new Money(50, "EUR").equals(new Money(60, "EUR"))).toBe(false);
  });

  it("recurses into nested VOs for structural equality", () => {
    const a = new TimeRange(new LocalTime(9, 0), new LocalTime(17, 0));
    const b = new TimeRange(new LocalTime(9, 0), new LocalTime(17, 0));
    expect(a.equals(b)).toBe(true);
  });

  it("returns false when two different VO classes have identical field shapes", () => {
    expect(new Money(50, "EUR").equals(new WeirdEqMoney(50, "EUR"))).toBe(false);
  });

  it("compares list-shaped embedded VOs element-wise", () => {
    expect(new Tags(["a", "b"]).equals(new Tags(["a", "b"]))).toBe(true);
    expect(new Tags(["a", "b"]).equals(new Tags(["b", "a"]))).toBe(false);
  });

  it("uses an overridden equals() implementation when provided", () => {
    expect(new WeirdEqMoney(1, "EUR").equals(new WeirdEqMoney(999, "EUR"))).toBe(true);
    expect(new WeirdEqMoney(1, "EUR").equals(new WeirdEqMoney(1, "USD"))).toBe(false);
  });

  it("returns false when compared to null or a non-VO value", () => {
    const m = new Money(50, "EUR");
    expect(m.equals(null)).toBe(false);
    expect(m.equals(undefined)).toBe(false);
    expect(m.equals({ amount: 50, currency: "EUR" })).toBe(false);
  });
});

describe("ValueObject — key()", () => {
  it("returns the same key for two VOs with identical field values", () => {
    expect(new Money(50, "EUR").key()).toBe(new Money(50, "EUR").key());
  });

  it("returns different keys when any field differs", () => {
    expect(new Money(50, "EUR").key()).not.toBe(new Money(50, "USD").key());
    expect(new Money(50, "EUR").key()).not.toBe(new Money(60, "EUR").key());
  });

  it("recurses into nested VOs so equal nesting produces equal keys", () => {
    const a = new TimeRange(new LocalTime(9, 0), new LocalTime(17, 0));
    const b = new TimeRange(new LocalTime(9, 0), new LocalTime(17, 0));
    expect(a.key()).toBe(b.key());
  });

  it("is order-sensitive for list-shaped JSON VOs", () => {
    expect(new Tags(["a", "b"]).key()).toBe(new Tags(["a", "b"]).key());
    expect(new Tags(["a", "b"]).key()).not.toBe(new Tags(["b", "a"]).key());
  });

  it("serializes null optional fields stably", () => {
    expect(new Price(100, null).key()).toBe(new Price(100, null).key());
    expect(new Price(100, null).key()).not.toBe(new Price(100, 10).key());
  });

  it("respects @field({ attributeName }) — keys reflect schema names, not property names", () => {
    const k = new Money(50, "EUR").key();
    expect(k).toContain("amount");
    expect(k).toContain("currency");
  });

  it("makes VOs usable as Map keys via key()", () => {
    const map = new Map<string, number>();
    map.set(new Money(50, "EUR").key(), 1);
    expect(map.get(new Money(50, "EUR").key())).toBe(1);
    expect(map.get(new Money(50, "USD").key())).toBeUndefined();
  });

  it("does NOT discriminate by class — two VO classes with the same field shape share a key", () => {
    expect(new Money(50, "EUR").key()).toBe(new WeirdEqMoney(50, "EUR").key());
  });
});

describe("ValueObject — withX cloning", () => {
  it("returns an instance that equals the original when withX is a no-op", () => {
    const m = new Money(50, "EUR");
    expect(m.withAmount(50).equals(m)).toBe(true);
    expect(m.withAmount(50)).not.toBe(m);
  });

  it("re-runs constructor invariants on withX (routes through the constructor)", () => {
    const m = new Money(50, "EUR");
    expect(() => m.withAmount(-1)).toThrow("Money.amount must be >= 0");
  });

  it("freezes the cloned instance returned by withX", () => {
    const m = new Money(50, "EUR");
    const clone = m.withAmount(60);
    expect(Object.isFrozen(clone)).toBe(true);
  });
});

describe("ValueObject — singleColumn declaration constraints", () => {
  it("throws at registration when a singleColumn VO has more than one @field", () => {
    expect(() => {
      @valueObject({ storage: ValueObjectStorage.SingleColumn })
      class TwoField extends ValueObject {
        @field() readonly a: string;
        @field() readonly b: string;
        constructor(a: string, b: string) {
          super();
          this.a = a;
          this.b = b;
          Object.freeze(this);
        }
        override toString(): string { return this.a; }
      }
      return TwoField;
    }).toThrow(/singleColumn requires exactly one @field/);
  });

  it("throws at registration when the one @field is a nested ValueObject", () => {
    expect(() => {
      @valueObject({ storage: ValueObjectStorage.SingleColumn })
      class WithNested extends ValueObject {
        @field({ type: Money }) readonly money: Money;
        constructor(money: Money) {
          super();
          this.money = money;
          Object.freeze(this);
        }
        override toString(): string { return this.money.toString(); }
      }
      return WithNested;
    }).toThrow(/singleColumn supports only scalar fields/);
  });
});

describe("ValueObject — malformed declarations", () => {
  it("throws when a @valueObject class declares no @field fields", () => {
    expect(() => {
      @valueObject()
      class Empty extends ValueObject {
        readonly amount: number;
        constructor(amount: number) {
          super();
          this.amount = amount;
          Object.freeze(this);
        }
      }
      return Empty;
    }).toThrow(/no `@field\(\)`-decorated fields/);
  });
});

describe("ValueObject — reactivity", () => {
  it("fires a reaction observing model.price when the field is replaced", () => {
    withTestTransaction(() => {
      const l = new Listing(new Money(50, "EUR"), new Tags([]));
      let count = 0;
      const dispose = reaction(() => l.price, () => { count++; });
      l.price = new Money(60, "EUR");
      expect(count).toBe(1);
      dispose();
    });
  });

  it("fires a reaction observing model.price.amount when the field is replaced", () => {
    withTestTransaction(() => {
      const l = new Listing(new Money(50, "EUR"), new Tags([]));
      let observed = l.price.amount;
      const dispose = reaction(() => l.price.amount, a => { observed = a; });
      l.price = new Money(60, "EUR");
      expect(observed).toBe(60);
      dispose();
    });
  });

  it("fires a reaction observing model.tags when an embedded-JSON VO slot is replaced", () => {
    withTestTransaction(() => {
      const l = new Listing(new Money(50, "EUR"), new Tags(["a"]));
      let count = 0;
      const dispose = reaction(() => l.tags, () => { count++; });
      l.tags = new Tags(["a", "b"]);
      expect(count).toBe(1);
      dispose();
    });
  });
});
