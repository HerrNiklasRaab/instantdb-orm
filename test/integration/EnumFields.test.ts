import { describe, it, expect, beforeEach } from "vitest";
import {
  assertDefined,
  setupTestDatabase,
  type TestInstantDBClient,
} from "./support/instantdb-test-utils";
import { RootStore } from "../../src/object-graph/store/RootStore";
import type { AppSchema } from "../support/instant.schema";
import { User, UserRole, type UserStatus } from "../support/entities/User";

describe("Enum field support (Integration)", () => {
  let db: TestInstantDBClient;
  let store: RootStore<AppSchema>;

  beforeEach(() => {
    db = setupTestDatabase();
    store = new RootStore<AppSchema>({ db });
  });

  describe("string literal union enum", () => {
    it.each<UserStatus>(["active", "inactive", "pending"])(
      "round-trips '%s' through save and hydrate",
      async (status) => {
        const user = await store.transaction(() => {
          const u = new User("Enum Test");
          u.status = status;
          return u;
        });

        const freshStore = new RootStore<AppSchema>({ db });
        const users = await freshStore.queryModel(User);
        const hydrated = users.find((u) => u.id === user.id);

        assertDefined(hydrated);
        expect(hydrated.status).toBe(status);
      }
    );

    it("persists null when status is unset", async () => {
      const user = await store.transaction(() => new User("No Status"));

      const freshStore = new RootStore<AppSchema>({ db });
      const users = await freshStore.queryModel(User);
      const hydrated = users.find((u) => u.id === user.id);

      assertDefined(hydrated);
      expect(hydrated.status).toBeNull();
    });

    it("tracks status transitions across multiple saves", async () => {
      const user = await store.transaction(() => {
        const u = new User("Transitioning");
        u.status = "pending";
        return u;
      });

      await store.transaction(() => {
        user.status = "active";
      });
      await store.transaction(() => {
        user.status = "inactive";
      });

      const freshStore = new RootStore<AppSchema>({ db });
      const users = await freshStore.queryModel(User);
      const hydrated = users.find((u) => u.id === user.id);

      assertDefined(hydrated);
      expect(hydrated.status).toBe("inactive");
    });
  });

  describe("TypeScript native enum", () => {
    it.each([
      ["Admin", UserRole.Admin],
      ["Member", UserRole.Member],
      ["Guest", UserRole.Guest],
    ] as const)(
      "round-trips UserRole.%s through save and hydrate",
      async (_label, role) => {
        const user = await store.transaction(() => {
          const u = new User("Role Test");
          u.role = role;
          return u;
        });

        const freshStore = new RootStore<AppSchema>({ db });
        const users = await freshStore.queryModel(User);
        const hydrated = users.find((u) => u.id === user.id);

        assertDefined(hydrated);
        expect(hydrated.role).toBe(role);
      }
    );

    it("hydrates a value that equals the enum member", async () => {
      const user = await store.transaction(() => {
        const u = new User("Equality Test");
        u.role = UserRole.Admin;
        return u;
      });

      const freshStore = new RootStore<AppSchema>({ db });
      const users = await freshStore.queryModel(User);
      const hydrated = users.find((u) => u.id === user.id);

      assertDefined(hydrated);
      expect(hydrated.role === UserRole.Admin).toBe(true);
    });
  });
});
