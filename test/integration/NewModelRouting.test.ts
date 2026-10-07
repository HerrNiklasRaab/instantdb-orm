import { describe, it, expect, beforeEach } from "vitest";
import {
  assertDefined,
  connectTestClient,
} from "./support/clients";
import { RootStore } from "../../src/object-graph/store/RootStore";
import { User } from "../support/entities/User";

describe("New model routing (Plan A)", () => {

  beforeEach(() => {
  });

  it("isolates new models between concurrent transactions on different stores", async () => {
    const storeA = new RootStore({ client: connectTestClient() });
    const storeB = new RootStore({ client: connectTestClient() });

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
