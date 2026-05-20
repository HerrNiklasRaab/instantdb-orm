import { describe, it, expect, beforeEach } from "vitest";
import {
  assertDefined,
  setupTestDatabase,
  type TestInstantDBClient,
} from "./support/instantdb-test-utils";
import { RootStore } from "../../src/object-graph/store/RootStore";
import type { AppSchema } from "../support/instant.schema";
import { User } from "../support/entities/User";

describe("New model routing (Plan A)", () => {
  let db: TestInstantDBClient;

  beforeEach(() => {
    db = setupTestDatabase();
  });

  it("isolates new models between concurrent transactions on different stores", async () => {
    const storeA = new RootStore<AppSchema>({ db });
    const storeB = new RootStore<AppSchema>({ db });

    let userA: User | undefined;
    let userB: User | undefined;

    await Promise.all([
      storeA.transaction(() => {
        userA = new User("from-A");
      }),
      storeB.transaction(() => {
        userB = new User("from-B");
      }),
    ]);

    assertDefined(userA);
    assertDefined(userB);
    expect(storeA.getById(User, userA.id)).toBe(userA);
    expect(storeA.getById(User, userB.id)).toBeUndefined();
    expect(storeB.getById(User, userB.id)).toBe(userB);
    expect(storeB.getById(User, userA.id)).toBeUndefined();
  });
});
