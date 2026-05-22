import { describe, it, expect, beforeAll } from "vitest";
import { reaction } from "mobx";
import { configureEntityMeta, valueObject, ValueObject } from "../../src/object-graph";
import { withTestTransaction } from "../../src/testing";
import schema from "../support/instant.schema";
import {
  Money,
  LocalTime,
  TimeRange,
  Tags,
  WeirdEqMoney,
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
