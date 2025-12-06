import { describe, it, expect, beforeAll } from "vitest";
import { configureEntityMeta } from "../../src/object-graph";
import schema from "../instant.schema";
import { User } from "../entities/User";

// Configure entity metadata before tests (no database needed)
beforeAll(() => {
  configureEntityMeta(schema as Parameters<typeof configureEntityMeta>[0]);
});

describe("Change Tracking (Unit)", () => {
  function createUser(name = "Test User"): User {
    return new User(name);
  }

  describe("isDirty() - new entity", () => {
    it("new entity is dirty (needs to be inserted)", () => {
      const user = createUser();
      expect(user.isDirty()).toBe(true);
    });
  });

  describe("isDirty() - relationship assignment", () => {
    it("returns true after assigning one-to-one relationship", () => {
      const user = createUser();
      const referrer = createUser("Referrer");

      user.referredBy = referrer;

      expect(user.isDirty()).toBe(true);
    });

    it("returns true after adding to one-to-many relationship", () => {
      const user = createUser();
      const referral = createUser("Referral");

      user.referrals.push(referral);

      expect(user.isDirty()).toBe(true);
    });
  });

  describe("automatic timestamps", () => {
    it("sets createdAt and updatedAt automatically on new entity", () => {
      const before = new Date();
      const user = createUser();
      const after = new Date();

      expect(user.createdAt).toBeInstanceOf(Date);
      expect(user.updatedAt).toBeInstanceOf(Date);
      expect(user.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(user.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(user.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(user.updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });
});
