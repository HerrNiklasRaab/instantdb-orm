import { describe, it, expect, beforeEach } from "vitest";
import {
  setupTestDatabase,
  type TestInstantDBClient,
} from "../utils/instantdb-test-utils";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { User } from "../entities/User";

describe("New model routing (Plan A)", () => {
  let db: TestInstantDBClient;

  beforeEach(() => {
    db = setupTestDatabase();
  });

  it("isolates new models between concurrent transactions on different stores", async () => {
    const storeA = new RootStore({ db });
    const storeB = new RootStore({ db });

    let userA: User | undefined;
    let userB: User | undefined;

    await Promise.all([
      storeA.transaction(async () => {
        userA = new User("from-A");
      }),
      storeB.transaction(async () => {
        userB = new User("from-B");
      }),
    ]);

    expect(storeA.getById(User, userA!.id)).toBe(userA);
    expect(storeA.getById(User, userB!.id)).toBeUndefined();
    expect(storeB.getById(User, userB!.id)).toBe(userB);
    expect(storeB.getById(User, userA!.id)).toBeUndefined();
  });
});
