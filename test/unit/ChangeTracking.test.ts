import { describe, it, expect, beforeAll } from "vitest";
import { configureEntityMeta, Temporal } from "../../src/object-graph";
import schema from "../support/instant.schema";
import { User } from "../support/entities/User";
import { withTestTransaction } from "../../src/testing";

beforeAll(() => {
  configureEntityMeta(schema);
});

describe("Change Tracking (Unit)", () => {
  function createUser(name = "Test User"): User {
    return new User(name);
  }

  describe("automatic timestamps", () => {
    it("sets createdAt and updatedAt automatically on new entity", () => {
      withTestTransaction(() => {
        const floorMs = (i: Temporal.Instant): Temporal.Instant =>
          i.round({ smallestUnit: "millisecond", roundingMode: "floor" });
        const before = floorMs(Temporal.Now.instant());
        const user = createUser();
        const after = Temporal.Now.instant().round({ smallestUnit: "millisecond", roundingMode: "ceil" });

        expect(user.createdAt).toBeInstanceOf(Temporal.Instant);
        expect(user.updatedAt).toBeInstanceOf(Temporal.Instant);
        expect(Temporal.Instant.compare(user.createdAt, before)).toBeGreaterThanOrEqual(0);
        expect(Temporal.Instant.compare(user.createdAt, after)).toBeLessThanOrEqual(0);
        expect(Temporal.Instant.compare(user.updatedAt, before)).toBeGreaterThanOrEqual(0);
        expect(Temporal.Instant.compare(user.updatedAt, after)).toBeLessThanOrEqual(0);
      });
    });
  });
});
