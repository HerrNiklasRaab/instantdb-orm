import { describe, it, expect, beforeEach } from "vitest";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { Temporal } from "../../src/object-graph";
import type { AppSchema } from "../support/instant.schema";
import {
  assertDefined,
  setupTestDatabase,
  type TestInstantDBClient,
} from "./support/instantdb-test-utils";
import { Appointment } from "../support/entities/Appointment";
import { DateRange } from "../support/entities/temporalValueObjects";

const INSTANT = Temporal.Instant.from("2026-06-01T08:30:00Z");

describe("Temporal persistence (Integration)", () => {
  let db: TestInstantDBClient;
  let storeA: RootStore<AppSchema>;
  let storeB: RootStore<AppSchema>;

  beforeEach(() => {
    db = setupTestDatabase();
    storeA = new RootStore<AppSchema>({ db });
    storeB = new RootStore<AppSchema>({ db });
  });

  it("round-trips every Temporal scalar type through save and reload", async () => {
    const saved = await storeA.transaction(() => {
      const a = new Appointment(INSTANT);
      a.day = Temporal.PlainDate.from("2026-06-01");
      a.startTime = Temporal.PlainTime.from("18:30:00");
      a.localStart = Temporal.PlainDateTime.from("2026-06-01T10:30:00");
      a.billingMonth = Temporal.PlainYearMonth.from("2026-06");
      a.anniversary = Temporal.PlainMonthDay.from("--06-01");
      a.duration = Temporal.Duration.from("PT1H30M");
      return a;
    });

    const reloaded = (await storeB.queryModel(Appointment)).find((a) => a.id === saved.id);
    assertDefined(reloaded);

    expect(reloaded.scheduledFor.equals(INSTANT)).toBe(true);
    assertDefined(reloaded.day);
    expect(reloaded.day.equals(Temporal.PlainDate.from("2026-06-01"))).toBe(true);
    assertDefined(reloaded.startTime);
    expect(reloaded.startTime.equals(Temporal.PlainTime.from("18:30:00"))).toBe(true);
    assertDefined(reloaded.localStart);
    expect(reloaded.localStart.equals(Temporal.PlainDateTime.from("2026-06-01T10:30:00"))).toBe(true);
    assertDefined(reloaded.billingMonth);
    expect(reloaded.billingMonth.equals(Temporal.PlainYearMonth.from("2026-06"))).toBe(true);
    assertDefined(reloaded.anniversary);
    expect(reloaded.anniversary.equals(Temporal.PlainMonthDay.from("--06-01"))).toBe(true);
    assertDefined(reloaded.duration);
    expect(reloaded.duration.toString()).toBe("PT1H30M");
  });

  it("round-trips a Temporal value nested inside a ValueObject", async () => {
    const vacation = new DateRange(
      Temporal.PlainDate.from("2026-07-01"),
      Temporal.PlainDate.from("2026-07-14")
    );
    const saved = await storeA.transaction(() => {
      const a = new Appointment(INSTANT);
      a.vacation = vacation;
      return a;
    });

    const reloaded = (await storeB.queryModel(Appointment)).find((a) => a.id === saved.id);
    assertDefined(reloaded);
    assertDefined(reloaded.vacation);
    expect(reloaded.vacation).toBeInstanceOf(DateRange);
    expect(reloaded.vacation.equals(vacation)).toBe(true);
    expect(reloaded.vacation.from.equals(Temporal.PlainDate.from("2026-07-01"))).toBe(true);
  });

  it("round-trips ZonedDateTime preserving zone and offset across DST boundaries", async () => {
    const summer = Temporal.ZonedDateTime.from("2026-06-01T10:30:00+02:00[Europe/Berlin]");
    const winter = Temporal.ZonedDateTime.from("2026-12-01T10:30:00+01:00[Europe/Berlin]");

    const savedSummer = await storeA.transaction(() => {
      const a = new Appointment(INSTANT);
      a.zonedStart = summer;
      return a;
    });
    const savedWinter = await storeA.transaction(() => {
      const a = new Appointment(Temporal.Instant.from("2026-12-01T08:30:00Z"));
      a.zonedStart = winter;
      return a;
    });

    const all = await storeB.queryModel(Appointment);
    const rs = all.find((a) => a.id === savedSummer.id);
    const rw = all.find((a) => a.id === savedWinter.id);
    assertDefined(rs);
    assertDefined(rs.zonedStart);
    assertDefined(rw);
    assertDefined(rw.zonedStart);

    expect(rs.zonedStart.equals(summer)).toBe(true);
    expect(rs.zonedStart.timeZoneId).toBe("Europe/Berlin");
    expect(rs.zonedStart.offset).toBe("+02:00");
    expect(rs.zonedStart.toPlainDateTime().toString()).toBe("2026-06-01T10:30:00");

    expect(rw.zonedStart.equals(winter)).toBe(true);
    expect(rw.zonedStart.offset).toBe("+01:00");
    expect(rw.zonedStart.toPlainDateTime().toString()).toBe("2026-12-01T10:30:00");
  });

  it("round-trips a null optional Temporal field and persists clearing a set value", async () => {
    const saved = await storeA.transaction(() => new Appointment(INSTANT));

    let reloaded = (await storeB.queryModel(Appointment)).find((a) => a.id === saved.id);
    assertDefined(reloaded);
    expect(reloaded.day).toBeNull();

    await storeA.transaction(() => {
      saved.day = Temporal.PlainDate.from("2026-06-01");
    });
    await storeA.transaction(() => {
      saved.day = null;
    });

    reloaded = (await new RootStore<AppSchema>({ db }).queryModel(Appointment)).find(
      (a) => a.id === saved.id
    );
    assertDefined(reloaded);
    expect(reloaded.day).toBeNull();
  });

  it("hydrates base timestamps as Temporal.Instant", async () => {
    const saved = await storeA.transaction(() => new Appointment(INSTANT));

    const reloaded = (await storeB.queryModel(Appointment)).find((a) => a.id === saved.id);
    assertDefined(reloaded);
    expect(reloaded.createdAt).toBeInstanceOf(Temporal.Instant);
    expect(reloaded.updatedAt).toBeInstanceOf(Temporal.Instant);
  });
});
