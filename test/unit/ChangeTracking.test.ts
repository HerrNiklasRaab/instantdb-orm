import { describe, it, expect, beforeAll } from "vitest";
import { configureEntityMeta } from "../../src/object-graph";
import schema from "../instant.schema";
import { User } from "../entities/User";
import { withTestTransaction } from "../../src/testing";

// Configure entity metadata before tests (no database needed)
beforeAll(() => {
  configureEntityMeta(schema as Parameters<typeof configureEntityMeta>[0]);
});

describe("Change Tracking (Unit)", () => {
  function createUser(name = "Test User"): User {
    return new User(name);
  }

  describe("automatic timestamps", () => {
    it("sets createdAt and updatedAt automatically on new entity", () => {
      withTestTransaction(() => {
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
});
