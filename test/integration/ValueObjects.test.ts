import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import type { AppSchema } from "../support/instant.schema";
import {
  assertDefined,
  setupTestDatabase,
  txFor,
  type TestInstantDBClient,
} from "./support/instantdb-test-utils";
import {
  Money,
  LocalTime,
  TimeRange,
  Price,
  Tags,
  Schedule,
  RemappedMoney,
  Slug,
} from "../support/entities/valueObjects";
import { Listing } from "../support/entities/Listing";
import { RemappedListing } from "../support/entities/RemappedListing";
import { ValidatingListing } from "../support/entities/ValidatingListing";

function firstRow(result: unknown, entity: string): Record<string, unknown> {
  if (result === null || typeof result !== "object") {
    throw new Error("query result is not an object");
  }
  const rows: unknown = Reflect.get(result, entity);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`query returned no ${entity}`);
  }
  const first: unknown = rows[0];
  if (first === null || typeof first !== "object") {
    throw new Error("first row is not an object");
  }
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(first)) {
    record[key] = Reflect.get(first, key);
  }
  return record;
}

describe("ValueObject (Integration)", () => {
  let db: TestInstantDBClient;
  let storeA: RootStore<AppSchema>;
  let storeB: RootStore<AppSchema>;

  beforeEach(() => {
    db = setupTestDatabase();
    storeA = new RootStore<AppSchema>({ db });
    storeB = new RootStore<AppSchema>({ db });
  });

  describe("spread column naming", () => {
    it("maps `price: Money` to columns priceAmount + priceCurrency", async () => {
      const saved = await storeA.transaction(() => new Listing(new Money(50, "EUR"), new Tags([])));
      const result = await db.query({ listings: { $: { where: { id: saved.id } } } });
      const row = firstRow(result, "listings");
      expect(row.priceAmount).toBe(50);
      expect(row.priceCurrency).toBe("EUR");
    });

    it("disambiguates two Money fields on the same model via field-name prefix", async () => {
      const saved = await storeA.transaction(() => {
        const l = new Listing(new Money(50, "EUR"), new Tags([]));
        l.minBid = new Money(10, "EUR");
        return l;
      });
      const result = await db.query({ listings: { $: { where: { id: saved.id } } } });
      const row = firstRow(result, "listings");
      expect(row.priceAmount).toBe(50);
      expect(row.minBidAmount).toBe(10);
    });

    it("recursively prefixes nested spread VOs", async () => {
      const saved = await storeA.transaction(() => {
        const l = new Listing(new Money(50, "EUR"), new Tags([]));
        l.slot = new TimeRange(new LocalTime(9, 0), new LocalTime(17, 30));
        return l;
      });
      const result = await db.query({ listings: { $: { where: { id: saved.id } } } });
      const row = firstRow(result, "listings");
      expect(row.slotStartHour).toBe(9);
      expect(row.slotStartMinute).toBe(0);
      expect(row.slotEndHour).toBe(17);
      expect(row.slotEndMinute).toBe(30);
    });

    it("overrides a single field suffix via @field({ attributeName })", async () => {
      const saved = await storeA.transaction(() => new RemappedListing(new RemappedMoney(5000, "EUR")));
      const result = await db.query({ remappedListings: { $: { where: { id: saved.id } } } });
      const row = firstRow(result, "remappedListings");
      expect(row.priceCents).toBe(5000);
      expect(row.priceCurrency).toBe("EUR");
      expect("priceAmount" in row).toBe(false);
    });
  });

  describe("embedded JSON", () => {
    it("stores an embedded VO as a single JSON column named after the field", async () => {
      const saved = await storeA.transaction(() => new Listing(new Money(50, "EUR"), new Tags(["a", "b"])));
      const result = await db.query({ listings: { $: { where: { id: saved.id } } } });
      const row = firstRow(result, "listings");
      expect(row.tags).toEqual({ items: ["a", "b"] });
      expect("tagsItems" in row).toBe(false);
    });
  });

  describe("singleColumn storage", () => {
    it("writes one column named exactly after the model field — no inner-field suffix", async () => {
      const saved = await storeA.transaction(() => {
        const l = new Listing(new Money(50, "EUR"), new Tags([]));
        l.slug = new Slug("my-listing");
        return l;
      });
      const result = await db.query({ listings: { $: { where: { id: saved.id } } } });
      const row = firstRow(result, "listings");
      expect(row.slug).toBe("my-listing");
      expect("slugValue" in row).toBe(false);
    });

    it("stores the inner scalar as a primitive, not wrapped in an object", async () => {
      const saved = await storeA.transaction(() => {
        const l = new Listing(new Money(50, "EUR"), new Tags([]));
        l.slug = new Slug("plain-string");
        return l;
      });
      const result = await db.query({ listings: { $: { where: { id: saved.id } } } });
      const row = firstRow(result, "listings");
      expect(typeof row.slug).toBe("string");
    });

    it("hydrates a singleColumn VO into a frozen instance equal to the original", async () => {
      const saved = await storeA.transaction(() => {
        const l = new Listing(new Money(50, "EUR"), new Tags([]));
        l.slug = new Slug("hydration-test");
        return l;
      });
      const reloaded = (await storeB.queryModel(Listing)).find(l => l.id === saved.id);
      assertDefined(reloaded);
      assertDefined(reloaded.slug);
      expect(reloaded.slug).toBeInstanceOf(Slug);
      expect(reloaded.slug.equals(new Slug("hydration-test"))).toBe(true);
      expect(Object.isFrozen(reloaded.slug)).toBe(true);
    });

    it("writes null when the optional singleColumn field is set to null", async () => {
      const saved = await storeA.transaction(() => {
        const l = new Listing(new Money(50, "EUR"), new Tags([]));
        l.slug = new Slug("first");
        return l;
      });
      await storeA.transaction(() => {
        saved.slug = null;
      });
      const result = await db.query({ listings: { $: { where: { id: saved.id } } } });
      const row = firstRow(result, "listings");
      expect(row.slug).toBeNull();
    });

    it("hydrates null when the optional column is null", async () => {
      const saved = await storeA.transaction(() => new Listing(new Money(50, "EUR"), new Tags([])));
      const reloaded = (await storeB.queryModel(Listing)).find(l => l.id === saved.id);
      assertDefined(reloaded);
      expect(reloaded.slug).toBeNull();
    });
  });

  describe("change tracking", () => {
    async function reloadUpdatedAt(id: string): Promise<number> {
      const reloaded = (await new RootStore<AppSchema>({ db }).queryModel(Listing)).find(l => l.id === id);
      assertDefined(reloaded);
      return reloaded.updatedAt.getTime();
    }

    it("does not bump updatedAt when replacing a slot with a structurally-equal spread VO", async () => {
      const saved = await storeA.transaction(() => new Listing(new Money(50, "EUR"), new Tags([])));
      const before = await reloadUpdatedAt(saved.id);
      await storeA.transaction(() => {
        saved.price = new Money(50, "EUR");
      });
      const after = await reloadUpdatedAt(saved.id);
      expect(after).toBe(before);
    });

    it("advances updatedAt and persists the new value when one field differs", async () => {
      const saved = await storeA.transaction(() => new Listing(new Money(50, "EUR"), new Tags([])));
      const before = await reloadUpdatedAt(saved.id);
      await storeA.transaction(() => {
        saved.price = new Money(60, "EUR");
      });
      const after = await reloadUpdatedAt(saved.id);
      expect(after).not.toBe(before);
      const reloaded = (await new RootStore<AppSchema>({ db }).queryModel(Listing)).find(l => l.id === saved.id);
      assertDefined(reloaded);
      expect(reloaded.price.amount).toBe(60);
    });

    it("persists both new values when both fields differ", async () => {
      const saved = await storeA.transaction(() => new Listing(new Money(50, "EUR"), new Tags([])));
      await storeA.transaction(() => {
        saved.price = new Money(60, "USD");
      });
      const reloaded = (await new RootStore<AppSchema>({ db }).queryModel(Listing)).find(l => l.id === saved.id);
      assertDefined(reloaded);
      expect(reloaded.price.amount).toBe(60);
      expect(reloaded.price.currency).toBe("USD");
    });

    it("does not bump updatedAt when replacing an embedded-JSON VO with a structurally-equal one", async () => {
      const saved = await storeA.transaction(() => new Listing(new Money(50, "EUR"), new Tags(["a", "b"])));
      const before = await reloadUpdatedAt(saved.id);
      await storeA.transaction(() => {
        saved.tags = new Tags(["a", "b"]);
      });
      const after = await reloadUpdatedAt(saved.id);
      expect(after).toBe(before);
    });

    it("advances updatedAt and persists the new JSON when an embedded-JSON VO differs structurally", async () => {
      const saved = await storeA.transaction(() => new Listing(new Money(50, "EUR"), new Tags(["a", "b"])));
      const before = await reloadUpdatedAt(saved.id);
      await storeA.transaction(() => {
        saved.tags = new Tags(["a", "c"]);
      });
      const after = await reloadUpdatedAt(saved.id);
      expect(after).not.toBe(before);
      const reloaded = (await new RootStore<AppSchema>({ db }).queryModel(Listing)).find(l => l.id === saved.id);
      assertDefined(reloaded);
      expect(reloaded.tags.equals(new Tags(["a", "c"]))).toBe(true);
    });
  });

  describe("nullability writes", () => {
    it("writes null to every spread column when the field is set to null", async () => {
      const saved = await storeA.transaction(() => {
        const l = new Listing(new Money(50, "EUR"), new Tags([]));
        l.minBid = new Money(10, "EUR");
        return l;
      });
      await storeA.transaction(() => {
        saved.minBid = null;
      });
      const result = await db.query({ listings: { $: { where: { id: saved.id } } } });
      const row = firstRow(result, "listings");
      expect(row.minBidAmount).toBeNull();
      expect(row.minBidCurrency).toBeNull();
    });

    it("permits a @field({ optional: true }) field to be null without flipping the parent to null", async () => {
      const saved = await storeA.transaction(() => {
        const l = new Listing(new Money(50, "EUR"), new Tags([]));
        l.flexPrice = new Price(100, null);
        return l;
      });
      const reloaded = (await storeB.queryModel(Listing)).find(l => l.id === saved.id);
      assertDefined(reloaded);
      const flex = reloaded.flexPrice;
      assertDefined(flex);
      expect(flex.amount).toBe(100);
      expect(flex.discount).toBeNull();
    });
  });

  describe("hydration", () => {
    it("hydrates a spread VO into an instance structurally equal to one built via new", async () => {
      const saved = await storeA.transaction(() => new Listing(new Money(50, "EUR"), new Tags([])));
      const reloaded = (await storeB.queryModel(Listing)).find(l => l.id === saved.id);
      assertDefined(reloaded);
      expect(reloaded.price.equals(new Money(50, "EUR"))).toBe(true);
    });

    it("hydrates an embedded-JSON VO into an instance structurally equal to one built via new", async () => {
      const saved = await storeA.transaction(() => new Listing(new Money(50, "EUR"), new Tags(["a", "b"])));
      const reloaded = (await storeB.queryModel(Listing)).find(l => l.id === saved.id);
      assertDefined(reloaded);
      expect(reloaded.tags.equals(new Tags(["a", "b"]))).toBe(true);
    });

    it("freezes hydrated VO instances", async () => {
      const saved = await storeA.transaction(() => new Listing(new Money(50, "EUR"), new Tags([])));
      const reloaded = (await storeB.queryModel(Listing)).find(l => l.id === saved.id);
      assertDefined(reloaded);
      expect(Object.isFrozen(reloaded.price)).toBe(true);
    });

    it("hydrates nested spread VOs bottom-up (inner VOs are real instances)", async () => {
      const slot = new TimeRange(new LocalTime(9, 0), new LocalTime(17, 30));
      const saved = await storeA.transaction(() => {
        const l = new Listing(new Money(50, "EUR"), new Tags([]));
        l.slot = slot;
        return l;
      });
      const reloaded = (await storeB.queryModel(Listing)).find(l => l.id === saved.id);
      assertDefined(reloaded);
      const reloadedSlot = reloaded.slot;
      assertDefined(reloadedSlot);
      expect(reloadedSlot).toBeInstanceOf(TimeRange);
      expect(reloadedSlot.start).toBeInstanceOf(LocalTime);
      expect(reloadedSlot.end).toBeInstanceOf(LocalTime);
      expect(reloadedSlot.start.hour).toBe(9);
      expect(reloadedSlot.end.minute).toBe(30);
    });

    it("hydrates an unset nullable field as null", async () => {
      const saved = await storeA.transaction(() => new Listing(new Money(50, "EUR"), new Tags([])));
      const reloaded = (await storeB.queryModel(Listing)).find(l => l.id === saved.id);
      assertDefined(reloaded);
      expect(reloaded.minBid).toBeNull();
    });

    it("hydrates a VO with required + optional fields when required set and optional null", async () => {
      const saved = await storeA.transaction(() => {
        const l = new Listing(new Money(50, "EUR"), new Tags([]));
        l.flexPrice = new Price(100, null);
        return l;
      });
      const reloaded = (await storeB.queryModel(Listing)).find(l => l.id === saved.id);
      assertDefined(reloaded);
      const flex = reloaded.flexPrice;
      assertDefined(flex);
      expect(flex.amount).toBe(100);
      expect(flex.discount).toBeNull();
    });
  });

  describe("nested embedded JSON", () => {
    it("serializes a nested VO inside a JSON blob with bare (unprefixed) keys and round-trips through hydration", async () => {
      const weekday = new TimeRange(new LocalTime(9, 0), new LocalTime(17, 30));
      const saved = await storeA.transaction(() => {
        const l = new Listing(new Money(50, "EUR"), new Tags([]));
        l.schedule = new Schedule(weekday);
        return l;
      });
      const result = await db.query({ listings: { $: { where: { id: saved.id } } } });
      const row = firstRow(result, "listings");
      expect(row.schedule).toEqual({
        weekday: {
          start: { hour: 9, minute: 0 },
          end: { hour: 17, minute: 30 },
        },
      });
      const reloaded = (await storeB.queryModel(Listing)).find(l => l.id === saved.id);
      assertDefined(reloaded);
      const reloadedSchedule = reloaded.schedule;
      assertDefined(reloadedSchedule);
      expect(reloadedSchedule).toBeInstanceOf(Schedule);
      expect(reloadedSchedule.weekday).toBeInstanceOf(TimeRange);
      expect(reloadedSchedule.weekday.equals(weekday)).toBe(true);
    });
  });

  describe("write-boundary integrity", () => {
    it.skip("throws on commit when a non-nullable spread VO field is null in memory", async () => {
      const saved = await storeA.transaction(() => new Listing(new Money(50, "EUR"), new Tags([])));
      await expect(
        storeA.transaction(() => {
          Reflect.set(saved, "price", null);
        })
      ).rejects.toThrow();
    });

    it.skip("throws on commit when a non-nullable embedded-JSON VO field is null in memory", async () => {
      const saved = await storeA.transaction(() => new Listing(new Money(50, "EUR"), new Tags(["a"])));
      await expect(
        storeA.transaction(() => {
          Reflect.set(saved, "tags", null);
        })
      ).rejects.toThrow();
    });
  });

  describe("hydration tolerance (admin-context corruption setup)", () => {
    it("tolerates one required spread column being null while another is non-null", async () => {
      const saved = await storeA.transaction(() => {
        const l = new Listing(new Money(50, "EUR"), new Tags([]));
        l.minBid = new Money(10, "EUR");
        return l;
      });
      await db.transact([
        txFor(db.__adminDb.tx, "listings", saved.id).update({ minBidCurrency: null }),
      ]);
      await expect(new RootStore<AppSchema>({ db }).queryModel(Listing)).resolves.toBeDefined();
    });

    it("tolerates all required spread columns being null on a non-nullable field", async () => {
      const saved = await storeA.transaction(() => new Listing(new Money(50, "EUR"), new Tags([])));
      await db.transact([
        txFor(db.__adminDb.tx, "listings", saved.id).update({ priceAmount: null, priceCurrency: null }),
      ]);
      await expect(new RootStore<AppSchema>({ db }).queryModel(Listing)).resolves.toBeDefined();
    });

    it("tolerates a required field being null while an optional sibling is set", async () => {
      const saved = await storeA.transaction(() => {
        const l = new Listing(new Money(50, "EUR"), new Tags([]));
        l.flexPrice = new Price(100, null);
        return l;
      });
      await db.transact([
        txFor(db.__adminDb.tx, "listings", saved.id).update({ flexPriceAmount: null, flexPriceDiscount: 5 }),
      ]);
      await expect(new RootStore<AppSchema>({ db }).queryModel(Listing)).resolves.toBeDefined();
    });

    it("tolerates a null JSON column on a non-nullable embedded field", async () => {
      const saved = await storeA.transaction(() => new Listing(new Money(50, "EUR"), new Tags(["a"])));
      await db.transact([
        txFor(db.__adminDb.tx, "listings", saved.id).update({ tags: null }),
      ]);
      await expect(new RootStore<AppSchema>({ db }).queryModel(Listing)).resolves.toBeDefined();
    });

    it.skip("does not re-run constructor validation on hydration of out-of-range stored data", async () => {
      const saved = await storeA.transaction(() => new Listing(new Money(0, "EUR"), new Tags([])));
      await db.transact([
        txFor(db.__adminDb.tx, "listings", saved.id).update({ priceAmount: -5 }),
      ]);
      const reloaded = (await new RootStore<AppSchema>({ db }).queryModel(Listing)).find(l => l.id === saved.id);
      assertDefined(reloaded);
      expect(reloaded.price.amount).toBe(-5);
    });
  });

  describe("VO-field discovery for constructor-validating models", () => {
    it("discovers VO fields without invoking the Model constructor (nullable field hydrates as null, required field round-trips)", async () => {
      const saved = await storeA.transaction(() => new ValidatingListing(new Money(75, "EUR")));
      const reloaded = (await storeB.queryModel(ValidatingListing)).find(l => l.id === saved.id);
      assertDefined(reloaded);
      expect(reloaded.price.equals(new Money(75, "EUR"))).toBe(true);
      expect(reloaded.slot).toBeNull();
    });
  });
});
